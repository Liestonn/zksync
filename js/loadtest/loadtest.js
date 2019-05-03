const ethers = require('ethers')
const Franklin = require('../franklin/src/franklin')
var Prando = require('prando')

const provider = new ethers.providers.JsonRpcProvider()
const franklin = new Franklin(process.env.API_SERVER, provider, process.env.CONTRACT_ADDR)
const sleep = async ms => await new Promise(resolve => setTimeout(resolve, ms))

let source = ethers.Wallet.fromMnemonic(process.env.MNEMONIC, "m/44'/60'/0'/0/0").connect(provider)
let sourceNonce = null

const TX_FEE = ethers.utils.parseEther('0.0003')
const MIN_AMOUNT_FRA = ethers.utils.parseEther('0.0001')
const TO_DEPOSIT = MIN_AMOUNT_FRA // MIN_AMOUNT_FRA.add(TX_FEE)
const TO_FUND = TO_DEPOSIT.add(TX_FEE)

let nClients = process.env.LOADTEST_N_CLIENTS
let tps = process.env.LOADTEST_TPS

let clients = []

let rng = new Prando(1) // deterministic seed

function randomClient() {
    let i = rng.nextInt(0, nClients-1)
    //console.log('i', i)
    return clients[ i ]
}

console.log(`Usage: yarn test -- [nClients] [TPS]`)
console.log(`Starting loadtest for ${nClients} with ${tps} TPS`)

class Client {

    constructor(id) {
        this.id = id
        console.log(`creating client #${this.id}`)
    }

    async prepare() {
        let signer = ethers.Wallet.fromMnemonic(process.env.MNEMONIC, "m/44'/60'/0'/1/" + this.id)
        this.fra = await franklin.Wallet.fromSigner(signer)
        this.eth = this.fra.ethWallet
        console.log(`${this.eth.address}: prepare`)
        
        try {
            let fundingRequired = false
            await this.fra.pullState()
            if (this.fra.sidechainOpen) {
                let balance = this.fra.currentBalance
                console.log(`${this.eth.address}: sidechain account ${this.fra.sidechainAccountId}, current balance ${ethers.utils.formatEther(balance)}`)
                fundingRequired = balance.lt(MIN_AMOUNT_FRA)
            } else {
                console.log(`${this.eth.address}: sidechain account not open, deposit required`)
                fundingRequired = true
            }

            if (fundingRequired) {
                console.log(`${this.eth.address}: Franklin funding required`)

                // is wallet balance enough?
                let balance = await this.eth.getBalance()
                console.log(`${this.eth.address}: eth wallet balance is ${ethers.utils.formatEther(balance)} ETH`)
                if (balance.lt(TO_DEPOSIT)) {
                    console.log(`${this.eth.address}: wallet funding required`)
                    // transfer funds from source account
                    let request = await source.sendTransaction({
                        to:     this.eth.address,
                        value:  TO_FUND,
                        nonce:  sourceNonce++,
                    })
                    console.log(`${this.eth.address}: funding tx sent`)
                    let receipt = await request.wait()
                    console.log(`${this.eth.address}: funding tx mined`)
                }

                // deposit funds into franklin
                console.log(`${this.eth.address}: depositing ${ethers.utils.formatEther(TO_DEPOSIT)} ETH into Franklin`)
                let request = await this.fra.deposit(TO_DEPOSIT)
                console.log(`${this.eth.address}: deposit tx sent`)
                let receipt = await request.wait()
                console.log(`${this.eth.address}: deposit tx mined, waiting for zk proof`)
                while (!this.fra.sidechainOpen || this.fra.currentBalance.lt(TO_DEPOSIT)) {
                    await sleep(500)
                    await this.fra.pullState()
                }
                console.log(`${this.eth.address}: sidechain deposit complete`)
            }
        } catch (err) {
            console.log(`${this.eth.address}: ERROR: ${err}`)
            console.trace(err.stack)
        }
    }

    async randomTransfer() {
        let fromAccountId = this.fra.sidechainAccountId
        let toAccountId = null
        while (true) {
            let to = randomClient()
            //console.log(to)
            if (to.fra.sidechainOpen && to.fra.sidechainAccountId !== fromAccountId) {
                toAccountId = to.fra.sidechainAccountId
                break
            }
        }
        let balance_int = this.fra.currentBalance.div('1000000000000').div(2).toNumber()
        let round_amount = rng.nextInt(11, balance_int - 1)
        let amount = 
            ethers.utils.bigNumberify(round_amount)
            //ethers.utils.bigNumberify(20474)
            .mul('1000000000000')

        //console.log(`${this.eth.address}: transfer ${round_amount} from ${fromAccountId} to ${toAccountId}...`);

        let r = await this.fra.transfer(toAccountId, amount)
        if (r.accepted) {
            console.log(`${this.eth.address}: transfer ${round_amount} from ${fromAccountId} to ${toAccountId} ok`)
        } else {
            console.log(`${this.eth.address}: transfer ${round_amount} failed: ${JSON.stringify(r)}`)
        }
    }
}

async function test() {

    sourceNonce = await source.getTransactionCount("pending")

    console.log('creating clients...')
    for (let i=0; i < nClients; i++) {
        clients.push(new Client(i))
    }

    console.log('xx: preparing clients...')
    let promises = []
    for (let i=0; i < nClients; i++) {
        promises.push( clients[i].prepare() )
    }

    // console.log('waiting until the clients are ready...')
    await Promise.all(promises)

    console.log('xx: starting the test...')
    while(true) {
        var nextTick = new Date(new Date().getTime() + 1000);
        for (let i=0; i<tps; i++) {
            let client = randomClient()
            client.randomTransfer()
            await new Promise(resolve => setTimeout(resolve, 20))
        }
        console.log('-')
        while(nextTick > new Date()) {
            await new Promise(resolve => setTimeout(resolve, 1))
        }
    }
}

test()