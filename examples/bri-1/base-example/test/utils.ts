import { exec } from "child_process";
import * as log from "loglevel";
import { Client } from "pg";
import { Ident } from "provide-js";
import { AuthService } from "ts-natsutil";
import { ParticipantStack } from "../src/index";

export const promisedTimeout = (ms) => {
  return new Promise((resolve) => setTimeout(resolve, ms));
};

export const authenticateUser = async (identHost, email, password) => {
  const auth = await Ident.authenticate(
    {
      email: email,
      password: password,
    },
    "http",
    identHost
  );
  return auth;
};

export const baselineAppFactory = async (
  orgName,
  bearerToken,
  initiator,
  identHost,
  natsHost,
  natsPrivateKey,
  natsPublicKey,
  nchainHost,
  networkId,
  vaultHost,
  rcpEndpoint,
  rpcScheme,
  workgroup,
  workgroupName,
  workgroupToken,
  vaultSealUnsealKey
): Promise<ParticipantStack> => {
  const natsConfig = {
    bearerToken: "",
    natsServers: [natsHost],
    privateKey: natsPrivateKey,
    publicKey: natsPublicKey,
  };
  natsConfig.bearerToken = await vendNatsAuthorization(
    natsConfig,
    "baseline.inbound"
  );

  return new ParticipantStack(
    {
      identApiScheme: "http",
      identApiHost: identHost,
      initiator: initiator,
      nchainApiScheme: "http",
      nchainApiHost: nchainHost,
      networkId: networkId, // FIXME-- boostrap network genesis if no public testnet faucet is configured...
      orgName: orgName,
      rpcEndpoint: rcpEndpoint,
      rpcScheme: rpcScheme,
      token: bearerToken,
      vaultApiScheme: "http",
      vaultApiHost: vaultHost,
      vaultSealUnsealKey: vaultSealUnsealKey,
      workgroup: workgroup,
      workgroupName: workgroupName,
      workgroupToken: workgroupToken,
    },
    natsConfig
  );
};

export const configureTestnet = async (dbport, networkId) => {
  const nchainPgclient = new Client({
    user: "nchain",
    host: "0.0.0.0",
    database: "nchain_dev",
    password: "nchain",
    port: dbport,
  });

  try {
    await nchainPgclient.connect();
    await nchainPgclient.query(
      `UPDATE networks SET enabled = true WHERE id = '${networkId}'`
    );
  } finally {
    await nchainPgclient.end();
    return true;
  }
};

export const createUser = async (
  identHost,
  firstName,
  lastName,
  email,
  password
) => {
  const user = await Ident.createUser(
    {
      first_name: firstName,
      last_name: lastName,
      email: email,
      password: password,
    },
    "http",
    identHost
  );
  return user;
};

export const scrapeInvitationToken = async (container) => {
  let logs;
  exec(`docker logs ${container}`, (err, stdout, stderr) => {
    logs = stderr.toString();
  });

  // @TODO:: Check if the timeout is needed.
  await promisedTimeout(2500);

  const matches = logs.match(/\"dispatch invitation\: (.*)\"/);
  if (matches && matches.length > 0) {
    return matches[matches.length - 1];
  }
  return null;
};

export const vendNatsAuthorization = async (
  natsConfig,
  subject
): Promise<string> => {
  const authService = new AuthService(
    log,
    natsConfig?.audience || natsConfig.natsServers[0],
    natsConfig?.privateKey,
    natsConfig?.publicKey
  );

  const permissions = {
    publish: {
      allow: ["baseline.>"],
    },
    subscribe: {
      allow: [`baseline.inbound`],
    },
  };

  return await authService.vendBearerJWT(subject, 5000, permissions);
};

export const readBytes = (fd: any, sharedBuffer: any) => {
  const fs = require("fs");
  return new Promise((resolve: any, reject: any) => {
    fs.read(fd, sharedBuffer, 0, sharedBuffer.length, null, (err: any) => {
      if (err) {
        return reject(err);
      }
      resolve();
    });
  });
};

export async function* generateChunks(filePath: any, size: any) {
  const sharedBuffer = Buffer.alloc(size);
  const fs = require("fs");
  const stats = fs.statSync(filePath); // file details
  const fd = fs.openSync(filePath); // file descriptor
  let bytesRead = 0; // how many bytes were read
  let end = size;

  for (let i = 0; i < Math.ceil(stats.size / size); i++) {
    await readBytes(fd, sharedBuffer);
    bytesRead = (i + 1) * size;
    if (bytesRead > stats.size) {
      // When we reach the end of file,
      // we have to calculate how many bytes were actually read
      end = size - (bytesRead - stats.size);
    }
    yield sharedBuffer.slice(0, end);
  }
}
