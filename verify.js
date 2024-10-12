const ethers = require('ethers')
const fetch = require('node-fetch')
const fs = require('fs')
require('colors')
const Diff = require('diff')
require('dotenv').config()

const etherscanApiKey = process.env.ETHERSCAN_API_KEY

// Mapping of view method names to which contract they should point to
const contractMap = {
  newRocketDAOProposal: 'RocketDAOProposal',
  newRocketDAOProtocolProposal: 'RocketDAOProtocolProposal',
  newRocketDAOProtocolVerifier: 'RocketDAOProtocolVerifier',
  newRocketDAOProtocolSettingsProposals: 'RocketDAOProtocolSettingsProposals',
  newRocketDAOProtocolSettingsAuction: 'RocketDAOProtocolAuction',
  newRocketMinipoolManager: 'RocketMinipoolManager',
  newRocketNodeStaking: 'RocketNodeStaking',
  newRocketMinipoolDelegate: 'RocketMinipoolDelegate',
  newRocketNodeDeposit: 'RocketNodeDeposit',
  newRocketNetworkVoting: 'RocketNetworkVoting',
};

// Create new ethers provider
const provider = new ethers.providers.JsonRpcProvider(process.env.ETH_RPC)

// Set parameter per network
let upgradeAddress, etherscanApiUrl
switch (process.env.NETWORK) {
  case 'holesky':
    upgradeAddress = '0x761C86751255d8eAc9727392DCf3C77831e2A347'
    etherscanApiUrl = 'https://api-holesky.etherscan.io'
    break
  case 'mainnet':
    upgradeAddress = '0xc2C81454427b1E53Fdf5d3B45561e3c18F90f9eD'
    etherscanApiUrl = 'https://api.etherscan.io'
    break
  default:
    console.error(`Invalid network ${process.env.NETWORK}`)
    process.exit(1)
}

// Prints diff between a and d with console colors
function printDiff (a, b) {
  const diff = Diff.diffChars(a, b)

  diff.forEach((part) => {
    const color = part.added ? 'green' : part.removed ? 'red' : 'grey'
    process.stderr.write(part.value[color])
  })

  console.log()
}

let lastRequestTime

// Gets verified sources from etherscan (thanks Patches)
async function getVerifiedSources (address) {
  const url = `${etherscanApiUrl}/api?module=contract&action=getsourcecode&address=${address}&apikey=${etherscanApiKey}`

  // etherscan api rate limits to 5 calls per second. Wait 0.22 seconds between calls.
  var now = new Date()
  if (lastRequestTime != undefined && now - lastRequestTime < 220) {
    await new Promise((resolve) => {
      setTimeout(resolve, now - lastRequestTime)
    })
  }
  lastRequestTime = new Date()
  const response = await fetch(url)
  const data = await response.json()

  if (data.message !== 'OK') {
    console.error(
      '❌ Something went wrong getting verified source from etherscan')
    console.log(data)
    process.exit(1)
  }

  if (data.result[0].SourceCode.startsWith('{{')) {
    return JSON.parse(data.result[0].SourceCode.slice(1, -1))
  }

  // If the response isn't json, it's the plain text source of the contract
  return data.result[0].SourceCode
}

async function verifyTruffleArtifact (contractName, address) {
  // Grab the verified source from etherscan
  const source = await getVerifiedSources(address)

  // Load in the preamble
  const preamble = fs.readFileSync('rocketpool/scripts/preamble.sol')

  if (source.sources !== undefined) {
    // Loop over verified sources
    for (const path in source.sources) {

      let expectedSource

      if (path[0] === '@') {
        // Load third party dependency from node_modules in the git repo
        expectedSource = fs.readFileSync(`rocketpool/node_modules/${path}`).
          toString()
      } else {
        // Construct the expected source by adding the preamble to the source file from the git repo
        expectedSource = preamble +
          fs.readFileSync(`rocketpool/${path}`).toString()
      }

      const actualSource = source.sources[path].content

      // Compare the two
      if (expectedSource !== actualSource) {
        console.error(
          `❌ Unexpected source file ${path} found at ${address} for ${contractName}`.red)
        printDiff(expectedSource, actualSource)
        process.exit(1)
      }
    }
  } else {
    // All Rocket Pool contracts have multiple source files so error if only a single was returned
    console.error(
      `❌ Unexpected source found at ${address} for ${contractName}`.red)
    process.exit(1)
  }

  console.log(`✔ Verified contract at ${address} matches ${contractName}`.green)
}

async function go () {
  // Verify the upgrade contract itself
  await verifyTruffleArtifact('RocketUpgradeOneDotThreeDotOne', upgradeAddress)

  // Construct ABI and contract instance to call all the view methods on upgrade contract
  const upgradeAbi = [
    'function locked() view returns (bool)',
    'function corrections(uint256) view returns (address, int256)'
  ]
  for (const method in contractMap) {
    upgradeAbi.push(`function ${method}() view returns (address)`)
  }
  const contract = new ethers.Contract(upgradeAddress, upgradeAbi, provider)

  // Loop over methods, call them and then verify the address they return has correct verified source code
  for (const method in contractMap) {
    const address = await contract[method]()
    await verifyTruffleArtifact(contractMap[method], address)
  }

  // Output eth matched corrections
  console.log('ETH matched corrections:')
  let i = 0;
  while (true) {
    try {
      let correction = await contract.corrections(i++);
      console.log(` ${i}: ${correction[0]} = ${correction[1].toString()}`);
    } catch(e) {
      break;
    }
  }

  const locked = await contract.locked()

  if (!locked) {
    console.error(`❌ Upgrade contract is not locked`.red)
    process.exit(1)
  } else {
    // If we made it here then it was successful (failures exit early)
    console.log('✔ Verification successful'.green)
  }
}

go()
