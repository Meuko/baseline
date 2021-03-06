import {
  IBaselineRPC,
  IBlockchainService,
  IRegistry,
  IVault,
  baselineServiceFactory,
  baselineProviderProvide,
} from "@baseline-protocol/api";
import {
  IMessagingService,
  messagingProviderNats,
  messagingServiceFactory,
} from "@baseline-protocol/messaging";
import {
  IZKSnarkCircuitProvider,
  IZKSnarkCompilationArtifacts,
  IZKSnarkTrustedSetupArtifacts,
  zkSnarkCircuitProviderServiceFactory,
  zkSnarkCircuitProviderServiceZokrates,
  Element,
  elementify,
  rndHex,
  concatenateThenHash,
} from "@baseline-protocol/privacy";
import {
  Message as ProtocolMessage,
  Opcode,
  Intention,
  PayloadType,
  marshalProtocolMessage,
  unmarshalProtocolMessage,
} from "@baseline-protocol/types";
import {
  Application as Workgroup,
  Vault as ProvideVault,
  Organization,
  Token,
  Key as VaultKey,
} from "@provide/types";
import {
  Capabilities,
  Ident,
  Vault,
  capabilitiesFactory,
  nchainClientFactory,
} from "provide-js";

import { readFileSync } from "fs";
import { compile as solidityCompile } from "solc";
import * as jwt from "jsonwebtoken";
import * as log from "loglevel";
import { sha256 } from "js-sha256";
import { AuthService } from "ts-natsutil";
import { ethers as Eth } from "ethers";

import uuid4 from "uuid4";
import * as dv from "dotenv";
import mongoose from "mongoose";

// Testing
import { IdentWrapper } from "../../../bri-2/commit-mgr/src/db/controllers/Ident";
import { NonceManager } from "@ethersproject/experimental";
import { scrapeInvitationToken, generateChunks } from "../test/utils";
import { bnToBuf } from "./utils/utils";

import { ContractMgr, Mgr } from "../test/utils-ganache";
import {
  CommitmentMetaData,
  VerifierInterface,
  SuppContainer,
  FileStructure,
  Job,
  SupplierType,
} from "../src/mods/types";

import { requestAvailability } from "./mods/avail/avail";

const baselineProtocolMessageSubject = "baseline.inbound";

//const baselineDocumentSource = "./src/zkp/src/stateVerifier.zok";
//const baselineDocumentCircuitPath = "./src/zkp/artifacts/stateVerifierSHA";

const baselineDocumentSource = "./src/zkp/src/dummyVerifier.zok";
const baselineDocumentCircuitPath = "./src/zkp/artifacts/dummyVerifier";

const zokratesImportResolver = (_: any, path: any) => {
  let zokpath = `../../../lib/circuits/${path}`;
  if (!zokpath.match(/\.zok$/i)) {
    zokpath = `${zokpath}.zok`;
  }
  return {
    source: readFileSync(zokpath).toString(),
    location: path,
  };
};

export class ParticipantStack {
  private baseline?: IBaselineRPC & IBlockchainService & IRegistry & IVault;
  private baselineCircuitArtifacts?: IZKSnarkCompilationArtifacts;
  private baselineCircuitSetupArtifacts?: IZKSnarkTrustedSetupArtifacts;
  private baselineConfig?: any;
  private babyJubJub?: VaultKey;
  private hdwallet?: VaultKey;
  private initialized = false;
  private nats?: IMessagingService;
  private natsBearerTokens: { [key: string]: any } = {}; // mapping of third-party participant messaging endpoint => bearer token
  private natsConfig?: any;
  private protocolMessagesRx = 0;
  private protocolMessagesTx = 0;
  private protocolSubscriptions: any[] = [];
  private capabilities?: Capabilities;
  private contracts: any;
  private ganacheContracts: any;
  private zk?: IZKSnarkCircuitProvider;

  // Dummy storage for the WF Operators
  // Once availability data is sent back from a Supplier we will store
  // the data in [supplier_address] => [availability] format.
  private availabilityData: { [key: string]: FileStructure } = {};

  private org?: any;
  private workgroup?: any;
  private workgroupCounterparties: string[] = [];
  private workgroupToken?: any; // workgroup bearer token; used for automated setup
  private workflowIdentifier?: string; // workflow identifier; specific to the workgroup
  private workflowRecords: { [key: string]: any } = {}; // in-memory system of record

  private commitAccount: any;
  private commitAccounts: any;
  private commitMgrApiBob: any;
  private commitMgrApiAlice: any;

  private identService: any;
  private contractService: any;
  private identConnection: any;

  constructor(baselineConfig: any, natsConfig: any) {
    this.baselineConfig = baselineConfig;
    this.natsConfig = natsConfig;
  }

  async init() {
    if (this.initialized) {
      throw new Error(
        `already initialized participant stack: ${this.org.name}`
      );
    }

    this.baseline = await baselineServiceFactory(
      baselineProviderProvide,
      this.baselineConfig
    );
    this.nats = await messagingServiceFactory(
      messagingProviderNats,
      this.natsConfig
    );
    this.zk = await zkSnarkCircuitProviderServiceFactory(
      zkSnarkCircuitProviderServiceZokrates,
      {
        importResolver: zokratesImportResolver,
      }
    );

    if (this.natsConfig?.bearerToken) {
      //this.natsBearerTokens = this.natsConfig.natsBearerTokens;
      this.natsBearerTokens[
        this.natsConfig.natsServers[0]
      ] = this.natsConfig.bearerToken;
    }

    dv.config();

    this.contracts = {};

    // Same contracts structure but for the contracts deployed on Ganache.
    // @TODO:: Remove this? Not sure if we even need this. Just overwrite
    // this.contracts.
    this.ganacheContracts = {};
    this.startProtocolSubscriptions();

    // Add some commit-mgr hooks
    const request = require("supertest");
    this.commitMgrApiBob = request(process.env.B_MGR_API);
    this.commitMgrApiAlice = request(process.env.A_MGR_API);

    if (this.baselineConfig.initiator) {
      // Set up contract manager
      const provider = new Eth.providers.JsonRpcProvider("http://0.0.0.0:8545");
      this.contractService = new ContractMgr({
        endpoint: "http://0.0.0.0:8545",
        sender: (await provider.listAccounts())[2],
        mgr: this.commitMgrApiBob,
      });
      // Clear up merkle-store if it exists
      await this.merkleStoreSetup();
      // Setting up state variables for local Ganache accounts.
      await this.ganacheAccountSetup();
      // Retrieving and deploying all needed contracts on Ganache.
      await this.contractSetup();

      if (this.baselineConfig.workgroup && this.baselineConfig.workgroupToken) {
        await this.setWorkgroup(
          this.baselineConfig.workgroup,
          this.baselineConfig.workgroupToken
        );
      } else if (this.baselineConfig.workgroupName) {
        await this.createWorkgroup(this.baselineConfig.workgroupName);
      }

      await this.registerOrganization(
        this.baselineConfig.orgName,
        this.natsConfig.natsServers[0]
      );
    }

    this.initialized = true;
  }

  getBaselineCircuitArtifacts(): any | undefined {
    return this.baselineCircuitArtifacts;
  }

  getBaselineConfig(): any | undefined {
    return this.baselineConfig;
  }

  getBaselineService():
    | (IBaselineRPC & IBlockchainService & IRegistry & IVault)
    | undefined {
    return this.baseline;
  }

  getMessagingConfig(): any | undefined {
    return this.natsConfig;
  }

  getMessagingService(): IMessagingService | undefined {
    return this.nats;
  }

  getNatsBearerTokens(): { [key: string]: any } {
    return this.natsBearerTokens;
  }

  getOrganization(): any | undefined {
    return this.org;
  }

  getProtocolMessagesRx(): number {
    return this.protocolMessagesRx;
  }

  getProtocolMessagesTx(): number {
    return this.protocolMessagesTx;
  }

  getProtocolSubscriptions(): any[] {
    return this.protocolSubscriptions;
  }

  getWorkflowIdentifier(): any {
    return this.workflowIdentifier;
  }

  getWorkgroup(): any {
    return this.workgroup;
  }

  getWorkgroupToken(): any {
    return this.workgroupToken;
  }

  getWorkgroupContract(type: string): any {
    return this.contracts[type];
  }

  getWorkgroupContracts(): any[] {
    return this.contracts;
  }

  getWorkgroupContractGanache(type: string): any {
    return this.ganacheContracts[type];
  }

  getWorkgroupContractsGanache(): any[] {
    return this.ganacheContracts;
  }

  getWorkgroupCounterparties(): string[] {
    return this.workgroupCounterparties;
  }

  getGanacheKeys(): { [key: string]: string[] } {
    return {
      commitAccount: this.commitAccount,
      commitAccounts: this.commitAccounts,
    };
  }

  getAvailableSuppliers(): { [key: string]: FileStructure } {
    return this.availabilityData;
  }

  getAvailableSupplier(supplierAddr: string): FileStructure | undefined {
    return this.availabilityData[supplierAddr] || undefined;
  }

  private async ganacheAccountSetup() {
    const res = await this.commitMgrApiBob.post("/jsonrpc").send({
      jsonrpc: "2.0",
      method: "eth_accounts",
      params: [],
      id: 1,
    });

    this.commitAccount = [process.env.WALLET_PUBLIC_KEY];
    this.commitAccounts = res.body.result;
  }

  private async merkleStoreSetup() {
    const config = {
      mongo: {
        debug: "true",
        bufferMaxEntries: 8,
        firstConnectRetryDelaySecs: 5,
      },
      mongoose: {
        useUnifiedTopology: true,
        useNewUrlParser: true,
        useFindAndModify: false,
        useCreateIndex: true,
        poolSize: 5, // Max. number of simultaneous connections to maintain
        socketTimeoutMS: 0, // Use os-default, only useful when a network issue occurs and the peer becomes unavailable
        keepAlive: true, // KEEP ALIVE!
      },
    };

    //TODO::(Hamza) Initialise Alice's DB too.
    const dbCommit =
      "mongodb://" +
      `${process.env.B_DATABASE_USER}` +
      ":" +
      `${process.env.B_DATABASE_PASSWORD}` +
      "@" +
      `${process.env.B_DATABASE_HOST}` +
      "/" +
      `${process.env.B_DATABASE_NAME}`;

    // See https://github.com/Automattic/mongoose/issues/9335
    let merkleConnection = await mongoose.connect(dbCommit, config.mongoose);

    // Clear out all previous collections if there are any
    await this.collectionDropper(["merkle-trees"], merkleConnection.connection);
    await this.collectionDropper(
      ["organization", "user", "workgroup"],
      (await this.identConnector()).connection
    );
  }

  // @TODO::(Hamza) -- Scan for and delete Ident collections.
  private async collectionDropper(
    names: string[],
    con: mongoose.Connection
  ): Promise<any> {
    for (var name of names) {
      con.db.listCollections().toArray(async (_, collections) => {
        if (collections && collections.length > 0) {
          for (var collection of collections) {
            if (collection.name === name) {
              //console.log(`Found an old ${name} collection; delete.`);
              await con.db.dropCollection(name);
            }
          }
        }
      });
    }
  }

  private async identConnector(): Promise<any> {
    if (this.identService && this.identConnection) {
      return {
        service: this.identService,
        connection: this.identConnection,
      };
    } else {
      // Establish our Ident service
      const dbCommit =
        "mongodb://" +
        `${process.env.B_DATABASE_USER}` +
        ":" +
        `${process.env.B_DATABASE_PASSWORD}` +
        "@" +
        `${process.env.B_DATABASE_HOST}` +
        "/" +
        `${process.env.B_DATABASE_NAME}`;

      let dbIdent =
        dbCommit.replace(new RegExp(/\b\/[a-zA-Z]*\b/), "/ident") +
        "?authSource=admin"; //.replace(new RegExp(/\b[a-zA-Z]*:[a-zA-Z0-9]*@\b/), "");

      this.identConnection = await mongoose.createConnection(dbIdent, {
        useUnifiedTopology: true,
        useNewUrlParser: true,
        useFindAndModify: false,
        useCreateIndex: true,
        poolSize: 5, // Max. number of simultaneous connections to maintain
        socketTimeoutMS: 0, // Use os-default, only useful when a network issue occurs and the peer becomes unavailable
        keepAlive: true, // KEEP ALIVE!
      });

      this.identService = new IdentWrapper(this.identConnection);

      return {
        service: this.identService,
        connection: this.identConnection,
      };
    }
  }

  private async contractSetup(): Promise<any> {
    const erc1820Contract = JSON.parse(
      readFileSync(
        "../../bri-2/contracts/artifacts/ERC1820Registry.json"
      ).toString()
    ); // #3
    const orgRegistryContract = JSON.parse(
      readFileSync(
        "../../bri-2/contracts/artifacts/OrgRegistry.json"
      ).toString()
    ); // #4

    let erc1820Address = await this.contractService.compileContracts([
      {
        byteCode: erc1820Contract.bytecode,
      },
    ]);

    let orgRegistryAddress = await this.contractService.compileContracts([
      {
        byteCode: orgRegistryContract.bytecode,
        params: [
          {
            parType: "address",
            parValue: erc1820Address[0],
          },
        ],
      },
    ]);

    this.ganacheContracts = {
      "erc1820-registry": {
        address: erc1820Address[0],
        name: "ERC1820Registry",
        network_id: 0,
        params: {
          compiled_artifacts: erc1820Contract,
        },
        type: "erc1820-registry",
      },
      "organization-registry": {
        address: orgRegistryAddress[0],
        name: "OrgRegistry",
        network_id: 0,
        params: {
          compiled_artifacts: orgRegistryContract,
        },
        type: "organization-registry",
      },
    };
  }

  private async dispatchProtocolMessage(msg: ProtocolMessage): Promise<any> {
    if (msg.opcode === Opcode.Join) {
      const payload = JSON.parse(msg.payload.toString());
      const messagingEndpoint = await this.resolveMessagingEndpoint(
        payload.address
      );
      if (
        !messagingEndpoint ||
        !payload.address ||
        !payload.authorized_bearer_token
      ) {
        return Promise.reject(
          "failed to handle baseline JOIN protocol message"
        );
      }
      this.workgroupCounterparties.push(payload.address);
      this.natsBearerTokens[messagingEndpoint] =
        payload.authorized_bearer_token;
    } else if (msg.opcode === Opcode.Availability) {
      // Message was sent and we're currently in the subscription distribution phase;
      // this happens on the supplier's side. Time to handle the incoming request.

      let message_payload = JSON.parse(msg.payload.toString());

      // If the payload under Opcode.Availability contains a key called MJ it means
      // we're either trying to request availability of some supplier or reply to a
      // request from the WFOperator.
      if (Object.keys(message_payload).includes("MJ")) {
        if (message_payload.MJ.intention === Intention.Response) {
          // We're the wind farm operator; entering this branch means we've actually received a response
          // from some arbitrary supplier with availability data. Time to process said data.
          this.availabilityData[msg.sender] = JSON.parse(
            message_payload.MJ.availability
          );
        } else if ((message_payload.MJ.intention = Intention.Request)) {
          //  We're now in the supplier branch. If we're in here it means that the WFOperator has requested
          //  our availability. The following tasks are executed by the supplier in this branch:
          // 		Supplier generates new commitment using received MJ
          //    Supplier compares this newly generated commitment to the last inserted leaf
          // 		Supplier runs AVA module if commitments overlap
          // 		Supplier then returns supCont[mjID, supplierID, AVA, price] to Initiator

          const job = JSON.parse(message_payload.MJ.mj.data);
          const meta = JSON.parse(message_payload.MJ.meta.data);

          // Generate commitment
          const commitment = this.createCommitment(job, meta);
          const commitmentHash = concatenateThenHash(
            JSON.stringify(commitment, (_, key: any) =>
              typeof key === "bigint" ? key.toString() : key
            )
          );

          // Retrieve the latest entry from the merkle tree.
          const firstLeaf = (
            await this.requestMgr(Mgr.Alice, "baseline_getCommits", [
              this.contracts["shield"].address,
              0,
              5,
            ])
          )[0];

          // Compare commitmentHash to our commitment
          // Always assume that at this point we have just a single commitment.
          // This assumption is supposed to be held true because we're working
          // with Opcode.Availability. The whole workflow is repeated for each job
          // which in turn means that we're just dealing with Opcode.Availability
          // once.
          if (firstLeaf.hash !== commitmentHash) return;

          // Assume that this Availability checker only retrieves data from the current supplier's
          // database.
          const supplierAvail: FileStructure = (
            await requestAvailability(
              [SupplierType.TECHNICIAN],
              job.tw,
              job.reqs.taskLength
            )
          )[0];

          // Send the availability data back to the initiator.
          this.workgroupCounterparties.forEach(async (recipient) => {
            this.sendProtocolMessage(recipient, Opcode.Availability, {
              MJ: {
                id: `${message_payload.MJ.id}`,
                intention: `${Intention.Response}`,
                date: `${new Date().toDateString()}`,
                availability: `${JSON.stringify(supplierAvail)}`,
              },
            });
          });
        }
      } else if (Object.keys(message_payload).includes("NS")) {
        // If we're in this branch it means that we're trying to notify a supplier of the fact
        // that he/she has been selected for the job. NS stands for `Notify Supplier`

        const vOI = message_payload.NS;

        // NS -- Notify Selection contains a status which indicates whether you've been selected or not.
        // If you are selected; it means that you've also been sent a proposal. This proposal has already
        // been signed by the WF so we're now looking for the second signature from the supplier.
        if (vOI.status === true) {
          // Selected
          console.log("Supplier has received acceptance.");
          console.log(JSON.stringify(vOI, undefined, 2));
          let signatures = vOI.signatures;

          // Do some processing, verify the signature, either accept or reject the proposal
          // As we're just testing, let's just accept it, sign it, and send it back.
          let doubleSigned = concatenateThenHash(vOI.proposal, signatures[0]);
          doubleSigned = doubleSigned.substr(2, doubleSigned.length);

          signatures.push((await this.signMessage(doubleSigned)).signature);

          console.log(
            `Supplier just double signed the proposal \n Signature: ${JSON.stringify(
              signatures,
              undefined,
              2
            )}`
          );

          console.log(
            `Address: ${vOI.selectedAddress} \n LeafIndex: ${vOI.leafIndex} \n SelectionRange: ${vOI.selectionRange}`
          );

          for (const address of this.getWorkgroupCounterparties()) {
            this.sendProtocolMessage(address, Opcode.Availability, {
              RN: {
                initSignedDoc: vOI.proposal,
                signatureCollection: JSON.stringify(signatures),
              },
            });
          }
        } else if (vOI.status === false) {
          // If we're in here, it means that we're a supplier AND that we haven't been chosen.
          // @-->>> TODO: Handle denial case.
          console.log("Supplier has received rejection.");
        }
      } else if (Object.keys(message_payload).includes("RN")) {
        // RN stands for "Respond Notification". This field is entered when the Supplier responds to the
        // WF's invitation/proposal message. @-->>> TODO: Also convert these in different opcodes.

        // @-->>> TODO: Make sure that we have a backup set to fall back onto if one of the suppliers denies our proposal.
        // @-->>> TODO: Wait for all suppliers in selection round to respond!

        const rea = message_payload.RN;

        // @-->>> TODO: Verify signatures etc..
        const signatureSet =
          typeof rea.signatureCollection === "string"
            ? JSON.parse(rea.signatureCollection)
            : rea.signatureCollection;

        // After verifying the signatures repack everything and get ready for creating a commitment.
        // @-->>> TODO: Make sure that the commitments are made using the commitment manager.
        const preBaselinedDocument = {
          document: rea.initSignedDoc,
          completeSetSignatures: JSON.stringify(signatureSet),
        };

        const hashedDocument = concatenateThenHash(preBaselinedDocument).substr(
          2
        );

        console.log(`Baselining MSA \n Commitment: ${hashedDocument}`);
      }
    }
  }

  // HACK!! workgroup/contracts should be synced via protocol
  async acceptWorkgroupInvite(
    inviteToken: string,
    contracts: any
  ): Promise<void> {
    if (
      this.workgroup ||
      this.workgroupToken ||
      this.org ||
      this.baselineConfig.initiator
    ) {
      return Promise.reject("failed to accept workgroup invite");
    }

    const invite = jwt.decode(inviteToken) as { [key: string]: any };

    await this.createWorkgroup(this.baselineConfig.workgroupName);

    this.ganacheContracts = this.contracts = {
      "erc1820-registry": {
        address: invite.prvd.data.params.erc1820_registry_contract_address,
        name: "ERC1820Registry",
        network_id: this.baselineConfig?.networkId,
        params: {
          compiled_artifacts:
            contracts["erc1820-registry"].params?.compiled_artifacts,
        },
        type: "erc1820-registry",
      },
      "organization-registry": {
        address: invite.prvd.data.params.organization_registry_contract_address,
        name: "OrgRegistry",
        network_id: this.baselineConfig?.networkId,
        params: {
          compiled_artifacts:
            contracts["organization-registry"].params?.compiled_artifacts,
        },
        type: "organization-registry",
      },
      shield: {
        address: invite.prvd.data.params.shield_contract_address,
        name: "Shield",
        network_id: this.baselineConfig?.networkId,
        params: {
          compiled_artifacts: contracts["shield"].params?.compiled_artifacts,
        },
        type: "shield",
      },
      verifier: {
        address: invite.prvd.data.params.verifier_contract_address,
        name: "Verifier",
        network_id: this.baselineConfig?.networkId,
        params: {
          compiled_artifacts: contracts["verifier"].params?.compiled_artifacts,
        },
        type: "verifier",
      },
    };

    const counterpartyAddr =
      invite.prvd.data.params.invitor_organization_address;

    this.workgroupCounterparties.push(counterpartyAddr);

    const messagingEndpoint = await this.resolveMessagingEndpoint(
      counterpartyAddr
    );
    const shieldAddr = invite.prvd.data.params.shield_contract_address;

    this.natsBearerTokens[messagingEndpoint] =
      invite.prvd.data.params.authorized_bearer_token;

    this.workflowIdentifier = invite.prvd.data.params.workflow_identifier;

    // @TODO::Hamza Remove this once #299 has been merged
    //this.baselineCircuitSetupArtifacts = invite.prvd.data.params.zk_data;

    const trackedShield = await this.requestMgr(Mgr.Alice, "baseline_track", [
      shieldAddr,
    ])
      .then((res: any) => {
        return res;
      })
      .catch(async (err: any) => {
        console.log(
          `Alice: Something went wrong trying to track the shield contract. \n Trying to retrieve trees and see if we're already tracking.`
        );
        const trackedShields = await this.requestMgr(
          Mgr.Alice,
          "baseline_getTracked",
          []
        );

        if (trackedShields.length === 0) {
          console.log(
            `No tracked shields in the database. \n Additional error information: ${err}`
          );
          return undefined;
        } else {
          console.log(
            `Found a lingering tracked shield in the database. All is good. Please ignore the previous messages.`
          );
          return trackedShields[0];
        }
      });

    if (!trackedShield) {
      console.log("Alice: WARNING: failed to track baseline shield contract");
    } else {
      console.log(
        `${this.baselineConfig.orgName} tracking shield under the address: ${shieldAddr}`
      );
    }

    // Register organization on-chain.
    await this.registerOrganization(
      this.baselineConfig.orgName,
      this.natsConfig.natsServers[0]
    );

    // Retrieve on-chain organization
    await this.requireOrganization(await this.resolveOrganizationAddress());

    await this.sendProtocolMessage(counterpartyAddr, Opcode.Join, {
      address: await this.resolveOrganizationAddress(),
      authorized_bearer_token: await this.vendNatsAuthorization(),
      workflow_identifier: this.workflowIdentifier,
    });
  }

  public marshalCircuitArg(val: string, fieldBits?: number): string[] {
    const el = elementify(val) as Element;
    return el.field(fieldBits || 128, 1, true);
  }

  async requestMgr(endpoint: Mgr, method: string, params: any): Promise<any> {
    // Baseline-RPCs
    // baseline_getCommit => params => contractAddress, leafIndex
    // baseline_getCommits => params => contractAddress, startLeafIndex, count
    // baseline_getRoot => params => contractAddress
    // baseline_getProof => params => contractAddress, leafIndex
    // baseline_getTracked => params => NONE
    // baseline_verifyAndPush => params => senderAddress, contractAddress, proof, publicInputs, newCommitment
    // baseline_track => params => contractAddress
    // baseline_untrack => params => contractAddress, prune
    // baseline_verify => params => contractAddress, leafValue, siblingNodes

    // Needed because each instance of commit-mgr can only track a single shield address.
    const ep =
      endpoint === Mgr.Bob ? this.commitMgrApiBob : this.commitMgrApiAlice;

    return await ep
      .post("/jsonrpc")
      .send({
        jsonrpc: "2.0",
        method: method,
        params: params,
        id: 1,
      })
      .then(async (res: any) => {
        if (res.status !== 200) {
          return Promise.reject(res.error || "Status on request was NOT 200");
        }
        try {
          const result = JSON.parse(res.text).result;

          if (Object.keys(result).includes("txHash")) {
            // Ensure that if we have a txHash, we wait for the TX
            // to finish. This means we don't have to use time-outs.
            const provider = new Eth.providers.JsonRpcProvider();
            const txHash = result.txHash;
            await provider.waitForTransaction(txHash);
          }

          return Promise.resolve(result);
        } catch (error) {
          return Promise.reject(error);
        }
      });
  }

  async generateProof(type: string, msg: any): Promise<any> {
    let args: any[] = [];

    switch (type) {
      case "genesis":
        args = msg.args;
        break;
      default:
        throw new Error("invalid proof type");
    }

    //@TODO:: Check why we're in here as Alice from the get-go.
    //@F001
    if (!this.baselineCircuitArtifacts?.program) {
      // Recompiling artifacts for Alice. This is fixed in #299
      // ethereum-oasis/baseline/pull/299
      // Once a circuit has been created, it has to be synced
      // between all parties involved. This is an artifical "sync"
      await this.compileBaselineCircuit();
    }

    // In general, running another setup doesn't work since it
    // will generate a new keypair. This can't be done in our cases
    // since the verifier deployed by bob contains the genesis-
    // generated VK. This means that if we want to submit our proof
    // to the same verifier ( which is mandatory ), we will need the
    // PK from Bob's setup. This is now sent through the invite.
    const fs = require("fs");
    const witness = (await this.zk?.computeWitness(
      this.baselineCircuitArtifacts!,
      args
    ))!.witness;
    const pk = fs.readFileSync(
      `${baselineDocumentCircuitPath}/keys/proving.key`
    );

    const proof = await (async (program: any, witness: any, pk: any) => {
      // Blank self out; if you don't do this Zokrates will error out.
      // Make sure to restore self once the call to Zokrates is done.
      const stateCapture = self;
      self = undefined as any;
      let proof = await this.zk?.generateProof(program, witness, pk);
      self = stateCapture;
      return proof;
    })(this.baselineCircuitArtifacts?.program, witness, pk);

    return {
      proof: proof,
    };
  }

  async createCommitment(
    MJ: Job,
    meta: CommitmentMetaData,
    leafIndexLC?: number,
    supCont?: SuppContainer
  ): Promise<VerifierInterface> {
    // Wrapper for around big-int since we can't compile to es2020
    // without losing the ability to use.?this.
    const bigInt = require("big-integer");
    const sha = require("sha.js");

    let mkLC: { lc1: bigint; lc2: bigint } = {
      lc1: bigInt(0),
      lc2: bigInt(0),
    };

    let state = meta.state;

    if (!leafIndexLC) leafIndexLC = 0;
    if (!supCont)
      supCont = {
        id: 0,
        supplierID: bigInt(0),
        docHash1: bigInt(0),
        docHash2: bigInt(0),
        contractH1: bigInt(0),
        contractH2: bigInt(0),
      } as SuppContainer;

    if (state == bigInt(0).value) {
      mkLC.lc1 = bigInt(0);
      mkLC.lc2 = bigInt(0);
    } else {
      // If state == 1 it means that we have a single previous commits; this will always be found at leafIndex 0
      const lastLeaf: any[] = await this.requestMgr(
        Mgr.Bob,
        "baseline_getCommits",
        [meta.shieldAddr, 0, 10]
      );

      let leafHash: string = lastLeaf[lastLeaf.length - 1].hash;
      leafHash = leafHash.substr(2, leafHash.length);

      const leafHashBN = bigInt(leafHash, 16).toString();

      mkLC.lc1 = bigInt(leafHashBN.substr(0, leafHashBN.length / 2));
      mkLC.lc2 = bigInt(
        leafHashBN.substr(leafHashBN.length / 2, leafHashBN.length)
      );
    }

    if (state == bigInt(1) || state == bigInt(2) || state == bigInt(5)) {
      supCont.supplierID = state;
      supCont.docHash1 = state;
      supCont.docHash2 = state;
      supCont.contractH1 = state;
      supCont.contractH2 = state;
    }

    let a: bigint = bigInt(0);
    let b: bigint = bigInt(0);
    let c: bigint = bigInt(0);
    let d: bigint = bigInt(0);
    let e: bigint = bigInt(0);
    let f: bigint = bigInt(0);
    let g: bigint = bigInt(0);
    let h: bigint = bigInt(0);
    let k: bigint = bigInt(0);

    if (state == bigInt(1) || state == bigInt(2) || state == bigInt(5)) {
      a = bigInt(0);
    } else {
      a = bigInt(1);
    }

    b = a * supCont.contractH1;
    c = a * supCont.contractH2;
    d = a * supCont.supplierID;
    e = a * supCont.docHash1;
    f = a * supCont.docHash2;

    if (state == bigInt(3) || state == bigInt(4)) {
      g = bigInt(1);
    } else {
      g = bigInt(0);
    }

    h = g * supCont.contractH1;
    k = g * supCont.contractH2;

    // Initiate body of inputs for verfier.sol
    let verifierInp: VerifierInterface = {
      mjID: MJ.id,
      state: state,
      supplierID: supCont.supplierID,
      docHash1: supCont.docHash1,
      docHash2: supCont.docHash2,
      contractH1: supCont.contractH1,
      contractH2: supCont.contractH2,
      lc1: mkLC.lc1,
      lc2: mkLC.lc2,
      nc1: bigInt(0),
      nc2: bigInt(0),
    };

    // Create body as input for the hashing and commitment generation
    let comBod: VerifierInterface = {
      mjID: verifierInp.mjID,
      state: verifierInp.state,
      supplierID: d,
      docHash1: e,
      docHash2: f,
      contractH1: h,
      contractH2: k,
      lc1: verifierInp.lc1,
      lc2: verifierInp.lc2,
      nc1: bigInt(0),
      nc2: bigInt(0),
    };

    ///// CALCULATE HASH1 ////////
    let in1 = bnToBuf("" + comBod.state); //create uint8array of state
    let in2 = bnToBuf("" + comBod.mjID); //create uint8array of MJ-ID
    let in3 = bnToBuf("" + comBod.supplierID); //create uint8array of supplierID
    let in4 = bnToBuf("" + comBod.lc1); //create unint8array of 1st part of latest commitment

    let inp14 = new Uint8Array([...in1, ...in2, ...in3, ...in4]);
    let hash1 = new sha.sha256().update(inp14).digest("hex"); //create hex hash1 of commitment
    let left1 = bigInt(hash1.slice(0, 32), 16).value; //create BigInt part of hash1
    let right1 = bigInt(hash1.slice(32, 64), 16).value; //create BigInt part of hash1

    ///// CALCULATE HASH2 ////////
    let in5 = bnToBuf("" + comBod.docHash1); //create uint8array of DocHash1
    let in6 = bnToBuf("" + comBod.docHash2); //create uint8array of DocHash2
    let in7 = bnToBuf("" + comBod.contractH1); //create uint8array of ContractHash1
    let in8 = bnToBuf("" + comBod.lc2); //create unint8array of 2nd part of latest commitment

    let inp58 = new Uint8Array([...in5, ...in6, ...in7, ...in8]);
    let hash2 = new sha.sha256().update(inp58).digest("hex"); //create hex hash2 of commitment
    let left2 = bigInt(hash2.slice(0, 32), 16).value; //create BigInt part of hash2
    let right2 = bigInt(hash2.slice(32, 64), 16).value; //create BigInt part of hash2

    //// CALCULATE COMMITMENT HASH /////
    let comar1 = bnToBuf("" + left1);
    let comar2 = bnToBuf("" + right1);
    let comar3 = bnToBuf("" + left2);
    let comar4 = bnToBuf("" + right2);
    let comarr = new Uint8Array([...comar1, ...comar2, ...comar3, ...comar4]);
    let hexhash = new sha.sha256().update(comarr).digest("hex");
    let newcom1 = bigInt(hexhash.slice(0, 32), 16).value;
    let newcom2 = bigInt(hexhash.slice(32, 64), 16).value;

    comBod.nc1 = newcom1;
    comBod.nc2 = newcom2;
    verifierInp.nc1 = newcom1;
    verifierInp.nc2 = newcom2;

    console.log(
      `Generated commitment data \n ${JSON.stringify(
        verifierInp,
        (_, key: any) => (typeof key === "bigint" ? key.toString() : key),
        2
      )}`
    );

    return Promise.resolve(verifierInp); //contains all the right inputs for proof generation for verifier.sol, including the newly generated commitment.
  }

  async resolveMessagingEndpoint(addr: string): Promise<string> {
    const org = await this.fetchOrganization(addr);

    if (!org) {
      return Promise.reject(`organization not resolved: ${addr}`);
    }

    const messagingEndpoint = org["config"].messaging_endpoint;

    if (!messagingEndpoint) {
      return Promise.reject(
        `organization messaging endpoint not resolved for recipient: ${addr}`
      );
    }

    return messagingEndpoint;
  }

  // Bearer auth tokens authorized by third parties are keyed on the messaging endpoint to which access is authorized
  async resolveNatsBearerToken(addr: string): Promise<string> {
    const endpoint = await this.resolveMessagingEndpoint(addr);
    if (!endpoint) {
      return Promise.reject(
        `failed to resolve messaging endpoint for participant: ${addr}`
      );
    }
    return this.natsBearerTokens[endpoint];
  }

  // This will accept recipients (string[]) for multi-party use-cases
  async sendProtocolMessage(
    recipient: string,
    opcode: Opcode,
    msg: any
  ): Promise<any> {
    const messagingEndpoint = await this.resolveMessagingEndpoint(recipient);
    if (!messagingEndpoint) {
      return Promise.reject(
        `protocol message not sent; organization messaging endpoint not resolved for recipient: ${recipient}`
      );
    }

    const bearerToken = this.natsBearerTokens[messagingEndpoint];
    if (!bearerToken) {
      return Promise.reject(
        `protocol message not sent; no bearer authorization cached for endpoint of recipient: ${recipient}`
      );
    }

    const recipientNatsConn = await messagingServiceFactory(
      messagingProviderNats,
      {
        bearerToken: bearerToken,
        natsServers: [messagingEndpoint],
      }
    );
    await recipientNatsConn.connect();

    if (msg.id && !this.workflowRecords[msg.id]) {
      this.workflowRecords[msg.id] = msg;
    }

    // this will use protocol buffers or similar
    const wiremsg = marshalProtocolMessage(
      await this.protocolMessageFactory(
        opcode,
        recipient,
        this.ganacheContracts["shield"].address,
        this.workflowIdentifier!,
        Buffer.from(JSON.stringify(msg))
      )
    );

    const result = recipientNatsConn.publish(
      baselineProtocolMessageSubject,
      wiremsg
    );
    this.protocolMessagesTx++;
    recipientNatsConn.disconnect();
    return result;
  }

  async createWorkgroup(name: string): Promise<Workgroup> {
    if (this.workgroup) {
      return Promise.reject(
        `workgroup not created; instance is associated with workgroup: ${this.workgroup.name}`
      );
    }

    this.workgroup = await this.baseline?.createWorkgroup({
      config: {
        baselined: true,
      },
      name: name,
      network_id: this.baselineConfig?.networkId,
    });

    const tokenResp = await this.createWorkgroupToken();
    this.workgroupToken = tokenResp.accessToken || tokenResp.token;

    if (this.baselineConfig.initiator) {
      // Deploy organization-registry
      await this.initWorkgroup();
    }

    return this.workgroup;
  }

  private async initWorkgroup(): Promise<void> {
    if (!this.workgroup) {
      return Promise.reject("failed to init workgroup");
    }

    this.capabilities = capabilitiesFactory();
    await this.requireCapabilities();

    const registryContracts = JSON.parse(
      JSON.stringify(this.capabilities?.getBaselineRegistryContracts())
    );

    const contractParams = registryContracts[2];

    await this.deployWorkgroupContract("Shuttle", "registry", contractParams);
    await this.requireWorkgroupContract("organization-registry");
  }

  async registerWorkgroupOrganization(): Promise<Organization> {
    if (!this.workgroup || !this.workgroupToken || !this.org) {
      return Promise.reject("failed to register workgroup organization");
    }

    return Ident.clientFactory(
      this.workgroupToken,
      this.baselineConfig?.identApiScheme,
      this.baselineConfig?.identApiHost
    ).createApplicationOrganization(this.workgroup.id, {
      organization_id: this.org.id,
    });
  }

  async setWorkgroup(workgroup: any, workgroupToken: any): Promise<void> {
    if (
      !workgroup ||
      !workgroupToken ||
      !this.workgroup ||
      this.workgroupToken
    ) {
      return Promise.reject("failed to set workgroup");
    }

    this.workgroup = workgroup;
    this.workgroupToken = workgroupToken;

    return this.initWorkgroup();
  }

  async fetchWorkgroupOrganizations(): Promise<Organization[]> {
    if (!this.workgroup || !this.workgroupToken) {
      return Promise.reject("failed to fetch workgroup organizations");
    }

    return await Ident.clientFactory(
      this.workgroupToken,
      this.baselineConfig?.identApiScheme,
      this.baselineConfig?.identApiHost
    ).fetchApplicationOrganizations(this.workgroup.id, {});
  }

  async createOrgToken(): Promise<Token> {
    return await Ident.clientFactory(
      this.baselineConfig?.token,
      this.baselineConfig?.identApiScheme,
      this.baselineConfig?.identApiHost
    ).createToken({
      organization_id: this.org.id,
    });
  }

  async createWorkgroupToken(): Promise<Token> {
    return await Ident.clientFactory(
      this.baselineConfig?.token,
      this.baselineConfig?.identApiScheme,
      this.baselineConfig?.identApiHost
    ).createToken({
      application_id: this.workgroup.id,
    });
  }

  async resolveOrganizationAddress(): Promise<string> {
    const keys = await this.fetchKeys();
    if (keys && keys.length >= 3) {
      return keys[2].address; // HACK!
    }
    return Promise.reject("failed to resolve organization address");
  }

  async fetchOrganization(address: string): Promise<Organization> {
    // fetchOrganization == On-chain registration.
    await this.requireWorkgroupContract("organization-registry");

    const resp = await this.g_retrieveOrganization(address)
      .then((org) => org)
      .catch((err) =>
        console.log(
          `Error while fetching organization under : ${address}. Error details: \n ${JSON.stringify(
            err,
            undefined,
            2
          )} \n Currently identified as ${this.org.name} under ${
            this.org.address
          }`
        )
      );

    if (resp) {
      const org = {} as Organization;
      org["name"] = resp["name"];
      org["address"] = resp["address"];
      org["config"] = {
        messaging_endpoint: "",
        zk_public_key: "",
        nats_bearer_token: "",
      };
      org["config"]["messaging_endpoint"] = resp["messagingEndpoint"];
      org["config"]["zk_public_key"] = resp["zkpPublicKey"];
      org["config"]["nats_bearer_token"] = resp["natsKey"];

      return Promise.resolve(org);
    }

    return Promise.reject(`failed to fetch organization ${address}`);
  }

  async fetchVaults(): Promise<ProvideVault[]> {
    const orgToken = await this.createOrgToken();
    const token = orgToken.accessToken || orgToken.token;
    return await Vault.clientFactory(
      token!,
      this.baselineConfig.vaultApiScheme!,
      this.baselineConfig.vaultApiHost!
    ).fetchVaults({});
  }

  async createVaultKey(
    vaultId: string,
    spec: string,
    type?: string,
    usage?: string
  ): Promise<VaultKey> {
    const orgToken = await this.createOrgToken();
    const token = orgToken.accessToken || orgToken.token;
    const vault = Vault.clientFactory(
      token!,
      this.baselineConfig?.vaultApiScheme,
      this.baselineConfig?.vaultApiHost
    );
    return await vault.createVaultKey(vaultId, {
      type: type || "asymmetric",
      usage: usage || "sign/verify",
      spec: spec,
      name: `${this.org.name} ${spec} keypair`,
      description: `${this.org.name} ${spec} keypair`,
    });
  }

  async requireVault(token?: string): Promise<ProvideVault> {
    let vault;
    let tkn = token;
    if (!tkn) {
      const orgToken = await this.createOrgToken();
      tkn = orgToken.accessToken || orgToken.token;
    }

    let interval;
    const promises = [] as any;
    promises.push(
      new Promise((resolve, reject) => {
        interval = setInterval(async () => {
          const vaults = await Vault.clientFactory(
            tkn!,
            this.baselineConfig.vaultApiScheme!,
            this.baselineConfig.vaultApiHost!
          ).fetchVaults({});
          if (vaults && vaults.length > 0) {
            vault = vaults[0];
            resolve();
          }
        }, 2500);
      })
    );

    await Promise.all(promises);
    clearInterval(interval);
    interval = null;

    return vault;
  }

  async signMessage(
    message: string,
    vaultId?: string,
    keyId?: string
  ): Promise<any> {
    if (!vaultId || !keyId) {
      vaultId = (await this.requireVault()).id;
      keyId = this.babyJubJub?.id;
    }

    const orgToken = await this.createOrgToken();
    const token = orgToken.accessToken || orgToken.token;
    const vault = Vault.clientFactory(
      token!,
      this.baselineConfig?.vaultApiScheme,
      this.baselineConfig?.vaultApiHost
    );

    console.log(
      `Signing process: \n Vault ID: ${vaultId} \n Key ID: ${keyId} \n Message: ${message}`
    );
    return await vault.signMessage(vaultId || "", keyId || "", message);
  }

  async fetchKeys(): Promise<any> {
    const orgToken = await this.createOrgToken();
    const token = orgToken.accessToken || orgToken.token;
    const vault = Vault.clientFactory(
      token!,
      this.baselineConfig?.vaultApiScheme,
      this.baselineConfig?.vaultApiHost
    );
    const vlt = await this.requireVault(token!);
    return await vault.fetchVaultKeys(vlt.id!, {});
  }

  async compileBaselineCircuit(): Promise<any> {
    const CHUNK_SIZE = 10000000;
    const fs = require("fs");
    const abi = fs
      .readFileSync(`${baselineDocumentCircuitPath}/abi.json`)
      .toString();

    let bufferCollecter = new Uint8Array();

    for await (const chunk of generateChunks(
      `${baselineDocumentCircuitPath}/out`,
      CHUNK_SIZE
    )) {
      let temp = new Uint8Array(chunk);
      let z = new Uint8Array(bufferCollecter.length + temp.length);
      z.set(bufferCollecter);
      z.set(temp, bufferCollecter.length);

      bufferCollecter = z;
    }

    this.baselineCircuitArtifacts = {
      program: bufferCollecter.slice(12, bufferCollecter.length),
      abi: abi,
    };

    return this.baselineCircuitArtifacts;
  }

  async deployBaselineCircuit(): Promise<any> {
    // compile the circuit...
    if (!this.baselineCircuitArtifacts) {
      await this.compileBaselineCircuit();
    }

    // @TODO::Hamza -- Enable this again, for testing purposes
    // we're using zokrates-CLI to pre-compile and generate everything.

    // Perform trusted setup and deploy verifier/shield contract
    //  const setupArtifacts: IZKSnarkTrustedSetupArtifacts =
    //	await (async (): Promise<IZKSnarkTrustedSetupArtifacts> => {
    //		const stateCapture = self;
    //		self = (undefined as any);
    //		const artifacts = await this.zk?.setup(this.baselineCircuitArtifacts);
    //		self = stateCapture;
    //		return artifacts!;
    //	})();

    // @TODO::Hamza -- Perhaps try using Radish's key import script?

    const compilerOutput = JSON.parse(
      solidityCompile(
        JSON.stringify({
          language: "Solidity",
          sources: {
            "verifier.sol": {
              //content: setupArtifacts?.verifierSource
              content: require("fs")
                .readFileSync(`${baselineDocumentCircuitPath}/verifier.sol`)
                .toString()
                ?.replace(/\^0.6.1/g, "^0.7.3")
                .replace(/view/g, ""),
            },
          },
          settings: {
            outputSelection: {
              "*": {
                "*": ["*"],
              },
            },
          },
        })
      )
    );

    if (
      !compilerOutput.contracts ||
      !compilerOutput.contracts["verifier.sol"]
    ) {
      throw new Error("verifier contract compilation failed");
    }

    const contractByte =
      "0x" +
      compilerOutput.contracts["verifier.sol"]["Verifier"]["evm"]["bytecode"][
        "object"
      ];

    const shieldContract = JSON.parse(
      readFileSync("../../bri-2/contracts/artifacts/Shield.json").toString()
    );

    // Begin Verifier Contract
    const verifierAddress = await this.contractService.compileContracts([
      {
        byteCode: contractByte,
      },
    ]);

    console.log("Verifier " + verifierAddress);

    const shieldAddress = await this.contractService.compileContracts([
      {
        byteCode: shieldContract.bytecode,
        params: [
          {
            parType: "address",
            parValue: verifierAddress[0],
          },
          {
            parType: "uint",
            parValue: 4,
          },
        ],
      },
    ]);

    console.log("Shield " + shieldAddress);

    const trackedShield = await this.requestMgr(Mgr.Bob, "baseline_track", [
      shieldAddress[0],
    ])
      .then((res: any) => res)
      .catch(() => undefined);

    if (!trackedShield) {
      console.log("WARNING: failed to track baseline shield contract");
    } else {
      console.log(
        `${this.org?.name} tracking shield under the address: ${shieldAddress}`
      );
    }

    this.contracts = this.ganacheContracts = {
      ...this.ganacheContracts,
      ...{
        shield: {
          address: shieldAddress[0],
          name: "Shield",
          network_id: 0,
          params: {
            compiled_artifacts: shieldContract,
          },
          type: "shield",
        },
        verifier: {
          address: verifierAddress[0],
          name: "Verifier",
          network_id: 0,
          params: {
            compiled_artifacts:
              compilerOutput.contracts["verifier.sol"]["Verifier"]["evm"],
          },
          type: "verifier",
        },
      },
    };

    //this.baselineCircuitSetupArtifacts = setupArtifacts;
    this.workflowIdentifier = uuid4(); //this.baselineCircuitSetupArtifacts?.identifier;

    return Promise.resolve();
  }

  async getTracked(): Promise<any> {
    const trackedShield = await this.commitMgrApiBob
      .post("/jsonrpc")
      .send({
        jsonrpc: "2.0",
        method: "baseline_getTracked",
        params: [],
        id: 1,
      })
      .then((res: any) => {
        if (res.status !== 200) return false;
        const parsedResponse: any = () => {
          try {
            return JSON.parse(res.text);
          } catch (error) {
            console.log(
              `ERROR while parsing baseline_getTracked response text ${JSON.stringify(
                error,
                undefined,
                2
              )}`
            );
            return undefined;
          }
        };
        return parsedResponse().result;
      });

    return trackedShield;
  }

  async getReceipt(txHash: string): Promise<any> {
    return await this.commitMgrApiBob.post("/jsonrpc").send({
      jsonrpc: "2.0",
      method: "eth_getTransactionReceipt",
      params: [txHash],
      id: 1,
    });
  }

  async deployWorkgroupContract(
    name: string,
    type: string,
    params: any,
    arvg?: any[]
  ): Promise<any> {
    if (!this.workgroupToken) {
      return Promise.reject("failed to deploy workgroup contract");
    }

    if (!params.bytecode && params.evm) {
      // HACK
      params.bytecode = `0x${params.evm.bytecode.object}`;
    }

    const nchain = nchainClientFactory(
      this.workgroupToken,
      this.baselineConfig?.nchainApiScheme,
      this.baselineConfig?.nchainApiHost
    );

    const signerResp = await nchain.createAccount({
      network_id: this.baselineConfig?.networkId,
    });

    const resp = await nchain.createContract({
      address: "0x",
      params: {
        account_id: signerResp["id"],
        compiled_artifact: params,
        // network: 'kovan',
        argv: arvg || [],
      },
      name: name,
      network_id: this.baselineConfig?.networkId,
      type: type,
    });
    if (resp && resp) {
      this.contracts[type] = resp;
      this.contracts[type].params = {
        compiled_artifact: params,
      };
    }
    return resp;
  }

  async deployWorkgroupShieldContract(): Promise<any> {
    const verifierContract = await this.requireWorkgroupContract("verifier");
    const registryContracts = JSON.parse(
      JSON.stringify(this.capabilities?.getBaselineRegistryContracts())
    );
    const contractParams = registryContracts[3]; // "shuttle circle" factory contract

    const argv = ["MerkleTreeSHA Shield", verifierContract.address, 32];

    // deploy EYBlockchain's MerkleTreeSHA contract (see https://github.com/EYBlockchain/timber)
    await this.deployWorkgroupContract(
      "ShuttleCircuit",
      "circuit",
      contractParams,
      argv
    );
    const shieldContract = await this.requireWorkgroupContract("shield");

    return shieldContract.address;
  }

  async inviteWorkgroupParticipant(email: string): Promise<string> {
    const bobOrg = await this.resolveOrganizationAddress();

    // Send invite
    await Ident.clientFactory(
      this.baselineConfig?.token,
      this.baselineConfig?.identApiScheme,
      this.baselineConfig?.identApiHost
    ).createInvitation({
      application_id: this.workgroup.id,
      email: email,
      permissions: 0,
      local_invitor: bobOrg,
    });

    // @TODO::Hamza -- Streamline this; looks messy.
    // We now have to decode and encode the token once again to replace the values.
    // It's either that or construct a brand new token. But since there might be
    // values we still need; i'm opting for the former. Ident cross-references all
    // values passed in with whatever is listed in its local registry. If we pass
    // our own addresses they will get overwritten.

    // Scrape invite
    let inviteToken = await scrapeInvitationToken("bob-ident-consumer");

    // Decode invite and reconstruct
    let decodedInvite = jwt.decode(inviteToken) as { [key: string]: any };

    decodedInvite.prvd.data.params = {
      erc1820_registry_contract_address: this.ganacheContracts[
        "erc1820-registry"
      ].address,
      invitor_organization_address: bobOrg,
      authorized_bearer_token: await this.vendNatsAuthorization(),
      organization_registry_contract_address: this.ganacheContracts[
        "organization-registry"
      ].address,
      shield_contract_address: this.ganacheContracts["shield"].address,
      verifier_contract_address: this.ganacheContracts["verifier"].address,
      workflow_identifier: this.workflowIdentifier,
      zk_data: {
        // @TODO::Hamza Exchange proving key!
        zkSource:
          require("fs").readFileSync(`${baselineDocumentSource}`) || "0x0",
      },
    };

    // Time to sign the reconstructed object
    const token = jwt.sign(decodedInvite, "0x0");

    return Promise.resolve(token);
  }

  private async requireCapabilities(): Promise<void> {
    let interval;
    const promises = [] as any;
    promises.push(
      new Promise((resolve, _) => {
        interval = setInterval(async () => {
          if (this.capabilities?.getBaselineRegistryContracts()) {
            resolve();
          }
        }, 500);
      })
    );

    await Promise.all(promises);
    clearInterval(interval);
    interval = null;
  }

  async requireOrganization(address: string): Promise<Organization> {
    let organization;
    let interval;

    const promises = [] as any;
    promises.push(
      new Promise((resolve, reject) => {
        interval = setInterval(async () => {
          this.fetchOrganization(address)
            .then((org) => {
              if (
                org &&
                org["address"].toLowerCase() === address.toLowerCase()
              ) {
                organization = org;
                resolve();
              }
            })
            .catch((err) => {
              reject(err);
            });
        }, 3500);
      })
    );

    await Promise.all(promises);
    clearInterval(interval);
    interval = null;

    return organization;
  }

  async requireWorkgroup(): Promise<void> {
    let interval;
    const promises = [] as any;
    promises.push(
      new Promise((resolve, _) => {
        interval = setInterval(async () => {
          if (this.workgroup) {
            resolve();
          }
        }, 3500);
      })
    );

    await Promise.all(promises);
    clearInterval(interval);
    interval = null;
  }

  async requireWorkgroupContract(type: string): Promise<any> {
    let contract;
    let interval;

    const promises = [] as any;
    promises.push(
      new Promise((resolve, _) => {
        interval = setInterval(async () => {
          this.resolveWorkgroupContract(type)
            .then((cntrct) => {
              contract = cntrct;
              resolve();
            })
            .catch((_) => {});
        }, 500);
      })
    );

    await Promise.all(promises);
    clearInterval(interval);
    interval = null;

    return contract;
  }

  async resolveWorkgroupContract(type: string): Promise<any> {
    if (
      this.ganacheContracts[type] &&
      this.ganacheContracts[type]["address"] !== "0x"
    ) {
      this.contracts[type] = this.ganacheContracts[type];
      return Promise.resolve(this.ganacheContracts[type]);
    }
    return Promise.reject();
  }

  async registerOrganization(
    name: string,
    messagingEndpoint: string
  ): Promise<any> {
    // *************************************************
    // Pre-organization creation through Ident. Not sure
    // what happens here. But I just assume that this is
    // pre-registration. We're not dealing with addresses
    // yet. These are assigned once this organization is
    // created and saved in Provide's Ident DB. Keys are
    // dealt with by Provide Vault.
    // *************************************************
    // Ident.createOrganization RETURN DATA ************
    //
    // createdAt: 2021-01-22T09:30:37.2481415Z
    // description: null
    // id: 4f7df75f-8521-4e76-a61e-72501c7cbe0d
    // metadata:
    // messaging_endpoint: nats://localhost:4224
    // name: Bob Corp
    // userId: 74651596-82e8-4ba9-9c9d-058b11bd8d50

    //this.org = await this.baseline?.createOrganization({
    //  name: name,
    //  metadata: {
    //    messaging_endpoint: messagingEndpoint,
    //  },
    //});

    // Required so that vault accepts our token :) Locally generated
    // id's hold no value in the Provide eco-system.
    const orgTokenVoucher = (
      await this.baseline?.createOrganization({
        name: name,
        metadata: {
          messaging_endpoint: messagingEndpoint,
        },
      })
    ).id;

    // Phase one -- Register organization locally
    await (await this.identConnector()).service
      .createOrganization({
        createdAt: new Date().toString(),
        name: name,
        userId: `${uuid4()}`,
        description: ``,
        metadata: {
          messaging_endpoint: messagingEndpoint,
        },
      })
      .then(async (org: any) => {
        this.org = JSON.parse(
          JSON.stringify({
            createdAt: org["createdAt"],
            description: org["description"],
            id: orgTokenVoucher,
            metadata: org["metadata"],
            messaging_endpoint: org["metadata"]["messaging_endpoint"],
            name: org["name"],
            userId: org["userId"],
          })
        );
      })
      .catch((err: any) => {
        console.log(
          `Something went wrong during organization setup. This is related to identity. \n Error details: ${err}`
        );
      });

    if (this.org) {
      // Phase two -- Create our keys
      const vault = await this.requireVault();
      // Our ZKP keypair
      this.babyJubJub = await this.createVaultKey(vault.id!, "babyJubJub");
      // Our organization keypair
      await this.createVaultKey(vault.id!, "secp256k1");
      this.hdwallet = await this.createVaultKey(vault.id!, "BIP39");

      // Phase three -- Register organization in registry
      await this.g_registerOrganization(
        this.org.name,
        (await this.fetchKeys())[2].address,
        this.org.messaging_endpoint,
        this.natsBearerTokens[this.org.messaging_endpoint] || "0x",
        this.babyJubJub?.publicKey!
      );

      await this.registerWorkgroupOrganization();
    } else {
      // @-->>> TODO: Check why we're sometimes coming in here.
      throw "Something went wrong while trying to setup an organization.";
    }

    return this.org;
  }

  async g_retrieveOrganization(address: any): Promise<any> {
    const orgRegistryContract = await this.requireWorkgroupContract(
      "organization-registry"
    );

    const registry_abi = orgRegistryContract.params.compiled_artifacts.abi;
    const url = "http://0.0.0.0:8545";
    const provider = new Eth.providers.JsonRpcProvider(url);
    const signer = provider.getSigner((await provider.listAccounts())[2]);
    const managedSigner = new NonceManager(signer);

    const orgConnector = new Eth.Contract(
      orgRegistryContract.address,
      registry_abi,
      managedSigner
    );

    return await orgConnector
      .getOrg(address)
      .then((rawOrg: any) => {
        return Promise.resolve({
          address: rawOrg[0],
          name: Eth.utils.parseBytes32String(rawOrg[1]),
          messagingEndpoint: Eth.utils.toUtf8String(rawOrg[2]),
          natsKey: Eth.utils.toUtf8String(rawOrg[3]),
          zkpPublicKey: Eth.utils.toUtf8String(rawOrg[4]),
          metadata: Eth.utils.toUtf8String(rawOrg[5]),
        });
      })
      .catch((err: any) => Promise.reject(err));
  }

  async g_registerOrganization(
    name: string,
    address: string,
    messagingEndpoint: string,
    messagingBearerToken: string,
    zkpPublicKey: string
  ): Promise<any> {
    // Process Description ************************************
    //
    // Organization registry happens in three phases.
    // Phase one: First we create the intial organization. This
    // organization is saved in some local/remote Identity DB.
    //
    // Phase two: Set up all organization related keys. This
    // in general hapens through a vault service. If you'd like
    // to be unsafe though, just save it with the organization
    // itself.
    //
    // Phase three: Once the previous two phases have been
    // executed. It is now time to add whatever data we've just
    // created to the organization registry smart contract.

    const orgRegistryContract = await this.requireWorkgroupContract(
      "organization-registry"
    );

    const registryAbi = orgRegistryContract.params.compiled_artifacts.abi;

    const url = "http://0.0.0.0:8545";
    const provider = new Eth.providers.JsonRpcProvider(url);

    const signer = provider.getSigner((await provider.listAccounts())[2]);
    const managedSigner = new NonceManager(signer);

    const registryConnector = new Eth.Contract(
      orgRegistryContract.address,
      registryAbi,
      managedSigner
    );

    const orgAddress =
      JSON.stringify(address).match(new RegExp(/\b0x[a-zA-Z0-9]{40}\b/))![0] ||
      "0x";

    let regOrg = await registryConnector
      .registerOrg(
        orgAddress,
        Eth.utils.formatBytes32String(name),
        Eth.utils.toUtf8Bytes(messagingEndpoint),
        Eth.utils.toUtf8Bytes(messagingBearerToken),
        Eth.utils.toUtf8Bytes(zkpPublicKey),
        Eth.utils.toUtf8Bytes("{}")
      )
      .then((res: any) => {
        // Decode our transaction data.
        const tempOrg = Eth.utils.defaultAbiCoder.decode(
          ["address", "bytes32", "bytes", "bytes", "bytes", "bytes"],
          // Remove first 4 bytes ( the function sighash )
          Eth.utils.hexDataSlice(res.data, 4)
        );

        // Parse the organization values and return it to base variable.
        return {
          // TODO::(Hamza) Check if this equals our secp256k1 key
          address: tempOrg[0],
          name: Eth.utils.parseBytes32String(tempOrg[1]),
          messagingEndpoint: Eth.utils.toUtf8String(tempOrg[2]),
          natsKey: Eth.utils.toUtf8String(tempOrg[3]),
          zkpPublicKey: Eth.utils.toUtf8String(tempOrg[4]),
          metadata: Eth.utils.toUtf8String(tempOrg[5]),
        };
      })
      .catch((e: any) => {
        throw Error("Error while trying to create organization." + e);
      });

    return regOrg;
  }

  async startProtocolSubscriptions(): Promise<any> {
    if (!this.nats?.isConnected()) {
      await this.nats?.connect();
    }

    const subscription = await this.nats?.subscribe(
      baselineProtocolMessageSubject,
      (msg) => {
        this.protocolMessagesRx++;
        this.dispatchProtocolMessage(
          unmarshalProtocolMessage(Buffer.from(msg.data))
        );
      }
    );

    this.protocolSubscriptions.push(subscription);
    return this.protocolSubscriptions;
  }

  async protocolMessageFactory(
    opcode: Opcode,
    recipient: string,
    shield: string,
    identifier: string,
    payload: Buffer
  ): Promise<ProtocolMessage> {
    const vaults = await this.fetchVaults();
    const signature = (
      await this.signMessage(
        sha256(payload.toString()),
        vaults[0].id!,
        this.hdwallet!.id!
      )
    ).signature;

    return {
      opcode: opcode,
      sender: await this.resolveOrganizationAddress(),
      recipient: recipient,
      shield: shield,
      identifier: identifier,
      signature: signature,
      type: PayloadType.Text,
      payload: payload,
    };
  }

  async vendNatsAuthorization(): Promise<string> {
    const authService = new AuthService(
      log,
      this.natsConfig?.audience || this.natsConfig.natsServers[0],
      this.natsConfig?.privateKey,
      this.natsConfig?.publicKey
    );

    const permissions = {
      publish: {
        allow: ["baseline.>"],
      },
      subscribe: {
        allow: [`baseline.inbound`],
      },
    };

    return await authService.vendBearerJWT(
      baselineProtocolMessageSubject,
      5000,
      permissions
    );
  }
}
