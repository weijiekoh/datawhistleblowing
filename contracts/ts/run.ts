// The MiMCSponge contract is not written in Solidity. Instead, its bytecode is
// generated by circomlib/src/mimcsponge_gencontract.js.
//
// Most (if not all) Solidity tooling frameworks, like Etherlime or Truffle,
// do not integrate the solc binary and therefore take ages to compile
// contracts.
//
// This script does the following:
//
// 1. Build the MiMC contract bytecode and deploy it to the Ethereum node
//    specified by --rpcUrl.
// 2. Copy Solidity files from the semaphore submodule to sol/semaphore
// 2. Compile the Solidity files specified by --input using the solc binary
//    specified by --solc. All output files will be in the directory specified
//    by --out.
// 3. Link the MiMC contract address to hardcoded contract(s) (just
//    MerkleTreeLib for now)
// 4. Deploy the rest of the contracts

import * as crypto from 'crypto'
import { config } from 'su-config'
import { ArgumentParser } from 'argparse'
import * as shell from 'shelljs'
import * as path from 'path'
import * as fs from 'fs'
import * as ethers from 'ethers'
import {
    SnarkProvingKey,
    SnarkVerifyingKey,
    parseVerifyingKeyJson,
    genExternalNullifier,
    genCircuit,
    Identity,
    genIdentity,
    genIdentityCommitment,
    genWitness,
    genProof,
    genPublicSignals,
    verifyProof,
    formatForVerifierContract,
} from 'libsemaphore'

const genAccounts = (
    num: number,
    mnemonic: string,
    provider: ethers.providers.JsonRpcProvider,
) => {
    let accounts: ethers.Wallet[] = []

    for (let i=0; i<num; i++) {
        const path = `m/44'/60'/${i}'/0/0`
        let wallet = ethers.Wallet.fromMnemonic(mnemonic, path)
        wallet = wallet.connect(provider)
        accounts.push(wallet)
    }

    return accounts
}

const mimcGenContract = require('circomlib/src/mimcsponge_gencontract.js')
const MIMC_SEED = 'mimcsponge'

const NUM_EXECUTIVES = config.numExecutives
const LOCKUP_NUM = config.lockupNum
const MAX_REPORT_NUM = config.maxReportNum
const DEPOSIT_AMT_ETH = config.depositAmtEth.toString()

let companyWallet
let investigatorWallet

const buildMimcBytecode = () => {
    return mimcGenContract.createCode(MIMC_SEED, 220)
}

const execute = (cmd: string) => {
    const result = shell.exec(cmd, { silent: false })
    if (result.code !== 0) {
        throw 'Error executing ' + cmd
    }

    return result
}

const readFile = (abiDir: string, filename: string) => {
    return fs.readFileSync(path.join(abiDir, filename)).toString()
}

const compileAbis = async (
    abiDir: string,
    solDir: string,
    solcBinaryPath: string = 'solc',
) => {
    shell.mkdir('-p', abiDir)
    const solcCmd = `${solcBinaryPath} -o ${abiDir} ${solDir}/*.sol --overwrite --abi`
    const result = execute(solcCmd)

    // Copy ABIs to the frontend and backend modules
    shell.mkdir('-p', '../frontend/abi/')

    shell.ls(path.join(abiDir, '*.abi')).forEach((file) => {
        const baseName = path.basename(file)
        shell.cp('-R', file, `../frontend/abi/${baseName}.json`)
    })
}

const compileAndDeploy = async (
    abiDir: string,
    solDir: string,
    solcBinaryPath: string = 'solc',
    provider: ethers.providers.JsonRpcProvider,
    deployerWallet: ethers.Wallet,
    companyWallet: ethers.Wallet,
    investigatorWallet: ethers.Wallet,
) => {

    const readAbiAndBin = (name: string) => {
        const abi = readFile(abiDir, name + '.abi')
        const bin = readFile(abiDir, name + '.bin')
        return { abi, bin }
    }

    // copy Semaphore files
    const semaphorePathPrefix = '../semaphore/semaphorejs/contracts/'
    const semaphoreTargetPath = path.join(solDir, 'semaphore')
    shell.mkdir('-p', semaphoreTargetPath)

    const semaphoreSolFiles = ['Semaphore.sol', 'MerkleTreeLib.sol', 'Ownable.sol']
    for (let file of semaphoreSolFiles) {
        shell.cp('-f', path.join(semaphorePathPrefix, file), semaphoreTargetPath)
    }

    shell.cp('-f', path.join(semaphorePathPrefix, '../build/verifier.sol'), semaphoreTargetPath)

    // Build MiMC bytecode
    const mimcBin = buildMimcBytecode()

    // compile contracts
    shell.mkdir('-p', abiDir)
    const solcCmd = `${solcBinaryPath} -o ${abiDir} ${solDir}/*.sol --overwrite --optimize --abi --bin`
    const result = execute(solcCmd)

    // deploy MiMC
    const mimcAbi = mimcGenContract.abi
    const mimcContractFactory = new ethers.ContractFactory(mimcAbi, mimcBin, deployerWallet)

    const mimcContract = await mimcContractFactory.deploy(
        {gasPrice: ethers.utils.parseUnits('10', 'gwei')}
    )
    await mimcContract.deployed()
    console.log('MiMC deployed at', mimcContract.address)

    // link contracts to MiMC
    const filesToLink = ['semaphore/MerkleTreeLib.sol']
    for (let fileToLink of filesToLink) {
        const filePath = path.join(solDir, fileToLink)
        const linkCmd = `${solcCmd} --libraries ${filePath}:MiMC:${mimcContract.address}`
        execute(linkCmd)
    }

    // deploy Semaphore
    const semaphoreAB = readAbiAndBin('Semaphore')
    const semaphoreContractFactory = new ethers.ContractFactory(semaphoreAB.abi, semaphoreAB.bin, deployerWallet)
    const semaphoreContract = await semaphoreContractFactory.deploy(
        config.chain.semaphoreTreeDepth, 0, 0,
        {gasPrice: ethers.utils.parseUnits('10', 'gwei')},
    )
    await semaphoreContract.deployed()

    console.log('Deployed Semaphore at', semaphoreContract.address)

    // deploy DataReporting
    const drAB = readAbiAndBin('DataReporting')
    const drContractFactory = new ethers.ContractFactory(drAB.abi, drAB.bin, deployerWallet)
    const drContract = await drContractFactory.deploy(
        semaphoreContract.address,
        ethers.utils.parseEther(DEPOSIT_AMT_ETH),
        LOCKUP_NUM,
        MAX_REPORT_NUM,
        companyWallet.address,
        investigatorWallet.address,
        {gasPrice: ethers.utils.parseUnits('10', 'gwei')},
    )
    await drContract.deployed()
    console.log('Deployed DataReporting at', drContract.address)

    // set the owner of the Semaphore contract to the SemaphoreClient contract address
    const tx = await semaphoreContract.transferOwnership(drContract.address)
    await tx.wait()
    console.log('Transferred ownership of the Semaphore contract')

    const numEth = 2
    const addressesToFund = [
        companyWallet.address,
        investigatorWallet.address,
    ]
    for (let address of addressesToFund) {
        let tx

        tx = await provider.sendTransaction(
            deployerWallet.sign({
                nonce: await provider.getTransactionCount(deployerWallet.address),
                gasPrice: ethers.utils.parseUnits('10', 'gwei'),
                gasLimit: 21000,
                to: address,
                value: ethers.utils.parseUnits(numEth.toString(), 'ether'),
                data: '0x'
            })
        )
        let receipt = await tx.wait()
        console.log(`Gave away ${numEth} ETH to`, address)
    }

	return {
		MiMC: mimcContract,
		Semaphore: semaphoreContract,
        DataReporting: drContract,
	}
}

const printBalances = async (drContract) => {
    let totalDeposited = await drContract.provider.getBalance(drContract.address)
    console.log('Total amount of ETH deposited:', ethers.utils.formatEther(totalDeposited))

    let totalLocked = await drContract.totalLockedWei()
    console.log('Amount of ETH locked:', ethers.utils.formatEther(totalLocked))

    let totalSeized = await drContract.totalSeizedWei()

    let retrievableDeposit = await drContract.retrievableDeposit()
    console.log(
        'Amount of previously locked ETH the company can retrieve:',
        ethers.utils.formatEther(retrievableDeposit),
    )
}

const main = async () => {
    const parser = new ArgumentParser({
        description: 'Build and deploy contracts'
    })

    parser.addArgument(
        ['-s', '--solc'],
        {
            help: 'The path to the solc binary',
            required: false,
        }
    )

    parser.addArgument(
        ['-r', '--rpcUrl'],
        {
            help: 'The JSON-RPC URL of the Ethereum node',
            required: false,
        }
    )

    parser.addArgument(
        ['-o', '--out'],
        {
            help: 'The output directory for compiled files',
            required: true,
        }
    )

    parser.addArgument(
        ['-i', '--input'],
        {
            help: 'The input directory with .sol files',
            required: true,
        }
    )

    // parse command-line options
    const args = parser.parseArgs()

    const abiDir = path.resolve(args.out)
    const solDir = path.resolve(args.input)
    const solcBinaryPath = args.solc ? args.solc : 'solc'

    const rpcUrl = args.rpcUrl ? args.rpcUrl : config.chain.url

    // generate provider and walllets
    const provider = new ethers.providers.JsonRpcProvider(rpcUrl)
    const wallets = genAccounts(3, config.chain.mnemonic, provider)

    const deployerWallet: ethers.Wallet = wallets[0]
    const companyWallet: ethers.Wallet = wallets[1]
    console.log('Company wallet:', companyWallet.address)
    const investigatorWallet: ethers.Wallet = wallets[2]

    // deploy contracts
    const contracts = await compileAndDeploy(
        abiDir,
        solDir,
        solcBinaryPath,
        provider,
        deployerWallet,
        companyWallet,
        investigatorWallet,
    )
    const mimcContract = contracts.MiMC
    const semaphoreContract = contracts.Semaphore
    const drContract = contracts.DataReporting

    console.log()
    console.log('========================================')

    // Generate and insert identities
    console.log('Registering executives')
    const identities: Identity[] = []
    for (let i=0; i < NUM_EXECUTIVES; i++) {
        const identity: Identity = genIdentity()
        identities.push(identity)

        const idc = '0x' + genIdentityCommitment(identity).toString(16)
        const tx = await drContract.insertIdentity(idc)
        await tx.wait()
        console.log(`    Executive ${i} registered identity commitment ${idc} via transaction ${tx.hash}`)
    }

    console.log()
    console.log('========================================')

    // Make deposits
    const reportHashes: string[] = []
    for (let i=1; i < MAX_REPORT_NUM + 1; i++) {
        console.log(`Day ${i}: company deposits ETH along with a hash of their report`)
        const drContractWithCompany = drContract.connect(companyWallet)
        const hash = genExternalNullifier(`Report ${i}`)
        reportHashes.push(hash)
        let tx = await drContractWithCompany.reportData(
            hash, 
            { value: ethers.utils.parseEther(DEPOSIT_AMT_ETH) },
        )
        await tx.wait()
    }

    // Report balances
    await printBalances(drContract)

    const circuitPath = path.join(__dirname, '../../semaphore/semaphorejs/build/circuit.json')
    const provingKeyPath = path.join(__dirname, '../../semaphore/semaphorejs/build/proving_key.bin')
    const verifyingKeyPath = path.join(__dirname, '../../semaphore/semaphorejs/build/verification_key.json')

    const cirDef = JSON.parse(fs.readFileSync(circuitPath).toString())
    const provingKey: SnarkProvingKey = fs.readFileSync(provingKeyPath)
    const verifyingKey: SnarkVerifyingKey = parseVerifyingKeyJson(fs.readFileSync(verifyingKeyPath).toString())
    const circuit = genCircuit(cirDef)
    
    console.log()
    console.log('========================================')

    // Whistleblow
    console.log(`One of the ${NUM_EXECUTIVES} executives will now blow the whistle.`)
    const leaves = await drContract.getIdentityCommitments()
    const identity = identities[0]
    const externalNullifier = reportHashes[0]

    const signal = ''
    const result = await genWitness(
        signal,
        circuit,
        identity,
        leaves,
        config.chain.semaphoreTreeDepth,
        externalNullifier,
    )
    let witness = result.witness
    console.log('Generating zk-SNARK proof...')
    const proof = await genProof(witness, provingKey)
    const publicSignals = genPublicSignals(witness, circuit)
    const isValid = verifyProof(verifyingKey, proof, publicSignals)
    const formatted = formatForVerifierContract(proof, publicSignals)

    const whistleblowTx = await drContract.blowWhistle(
        ethers.utils.toUtf8Bytes(signal),
        formatted.a,
        formatted.b,
        formatted.c,
        formatted.input,
    )
    const receipt = await whistleblowTx.wait()

    console.log()
    console.log('========================================')

    // Report balances
    await printBalances(drContract)

    console.log()
    console.log('========================================')

    console.log('The investigator has decided to seize the funds.')

    const investigatorBalanceBefore = await provider.getBalance(investigatorWallet.address)
    const drContractWithInvestigator = drContract.connect(investigatorWallet)
    const seizeTx = await drContractWithInvestigator.seizeDeposit()
    await seizeTx.wait()
    const investigatorBalanceAfter = await provider.getBalance(investigatorWallet.address)

    const balanceDiff = ethers.utils.formatEther(
        (investigatorBalanceAfter.sub(investigatorBalanceBefore)).toString(),
    )
    console.log(`The investigator's balance increased by ${balanceDiff} ETH.`)
    console.log('Note that the investigator paid gas for this transaction.')

    console.log()
    console.log('========================================')

    // Report balances
    await printBalances(drContract)

    console.log('Done.')

    return
}

if (require.main === module) {
    main()
}
