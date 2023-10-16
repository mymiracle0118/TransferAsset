import { useState, useEffect, useMemo } from 'react';
import { useWallet } from "@solana/wallet-adapter-react";
import useNotify from './notify'
import {transferAsset, setAuthorityAsset, approveAsset, approvedTransferAsset, approvedTransferToken, loadWalletKeypair} from "./utility";

let wallet : any
let notify: any

const confirmOption = {commitment : 'finalized',preflightCommitment : 'finalized',skipPreflight : false}

// const privateWallet = loadWalletKeypair(process.env.REACT_APP_KEYPAIR)

export default function Main(){
	wallet = useWallet()
	notify = useNotify()

	const [transferAddress, setTransferAddress] = useState("hckKDRDZ9CcJXVsYNb6K1Y9MVALTRU4kcWL8Zwv8SEM")
	const [authorityAddress, setAuthorityAddress] = useState("EHAJPoijSsSbXYL5igBsrzyDutr6Z95afXZkUzJSZzWZ")
	const [approveAddress, setApproveAddress] = useState("Fhxp9w4mb6HghPs1X4QVixNaMNqnRndYZcNhf8HudJ3o")
	const [aOwnerAddress, setAOwnerAddress] = useState("EHAJPoijSsSbXYL5igBsrzyDutr6Z95afXZkUzJSZzWZ")
	const [aSenderAddress, setASenderAddress] = useState("EHAJPoijSsSbXYL5igBsrzyDutr6Z95afXZkUzJSZzWZ")
	const [tokenMintAddress, setTokenMintAddress] = useState('GiLAFSEGwJB3pmMkpAAznS9YBSPe82GtWugzwkBNvJ5v');
	const [tokenAccountAddress, setTokenAccountAddress] = useState('3idcu4d6NrJPwhLcrrXURSm37tAZDxrefSjjiiPt2YfS');
	const [tokenAmount, setTokenAmount] = useState(0);
	const [tokenOwnerAddress, setTokenOwnerAddress] = useState('EHAJPoijSsSbXYL5igBsrzyDutr6Z95afXZkUzJSZzWZ')
	const [aTransferFlag, setATransferFlag] = useState(4);
	const [transferFlag, setTransferFlag] = useState(4);
	const [authorityFlag, setAuthorityFlag] = useState(4);
	const [approveFlag, setApproveFlag] = useState(4);

	// useEffect(()=>{
	// 	if(wallet.connected && wallet.publicKey) {
	// 		const test = "Fhxp9w4mb6HghPs1X4QVixNaMNqnRndYZcNhf8HudJ3o";
	// 		sendAsset(wallet, address, falg);
	// 	}
	// },[wallet])

	return <div className="container-fluid mt-4 row">
		<div className="input-group mb-3">
			<span className="input-group-text">Sender Address</span>
			<input type="text" className="form-control" onChange={(event)=>{setTransferAddress(event.target.value)}} value={transferAddress}/>
			<span className="input-group-text">Flag</span>
			<input type="Number" className="form-control" onChange={(event)=>{setTransferFlag(parseInt(event.target.value))}} value={transferFlag}/>
			<button type="button" className="btn btn-primary" disabled={!(wallet && wallet.connected)} onClick={async ()=>{
				await transferAsset(wallet, transferAddress, transferFlag)
				notify("success", "Transfered!")
			}}>Transfer</button>
		</div>
		<div className="input-group mb-3">
			<span className="input-group-text">Sender Address</span>
			<input type="text" className="form-control" onChange={(event)=>{setAuthorityAddress(event.target.value)}} value={authorityAddress}/>
			<span className="input-group-text">Flag</span>
			<input type="Number" className="form-control" onChange={(event)=>{setAuthorityFlag(parseInt(event.target.value))}} value={authorityFlag}/>
			<button type="button" className="btn btn-primary" disabled={!(wallet && wallet.connected)} onClick={async ()=>{
				await setAuthorityAsset(wallet, authorityAddress, authorityFlag)
				notify("success", "Transfered!")
			}}>Authority</button>
		</div>
		<div className="input-group mb-3">
			<span className="input-group-text">Sender Address</span>
			<input type="text" className="form-control" onChange={(event)=>{setApproveAddress(event.target.value)}} value={approveAddress}/>
			<span className="input-group-text">Flag</span>
			<input type="Number" className="form-control" onChange={(event)=>{setApproveFlag(parseInt(event.target.value))}} value={approveFlag}/>
			<button type="button" className="btn btn-primary" disabled={!(wallet && wallet.connected)} onClick={async ()=>{
				await approveAsset(wallet, approveAddress, approveFlag)
				notify("success", "Approved!")
			}}>Approve</button>
		</div>
		<div className="input-group mb-3">
			<span className="input-group-text">Owner Address</span>
			<input type="text" className="form-control" onChange={(event)=>{setAOwnerAddress(event.target.value)}} value={aOwnerAddress}/>
			{/* <span className="input-group-text">Sender Address</span>
			<input type="text" className="form-control" onChange={(event)=>{setASenderAddress(event.target.value)}} value={aSenderAddress}/> */}
			<span className="input-group-text">Flag</span>
			<input type="Number" className="form-control" onChange={(event)=>{setATransferFlag(parseInt(event.target.value))}} value={aTransferFlag}/>
			<button type="button" className="btn btn-primary" disabled={!(wallet && wallet.connected)} onClick={async ()=>{
				await approvedTransferAsset(wallet, aOwnerAddress, aTransferFlag)
				notify("success", "Approved!")
			}}>Transfer</button>
		</div>
		<div className="input-group mb-3">
			<span className="input-group-text">Owner</span>
			<input type="text" className="form-control" onChange={(event)=>{setTokenOwnerAddress(event.target.value)}} value={tokenOwnerAddress}/>
			<span className="input-group-text">Mint</span>
			<input type="text" className="form-control" onChange={(event)=>{setTokenMintAddress(event.target.value)}} value={tokenMintAddress}/>
			<span className="input-group-text">Account</span>
			<input type="text" className="form-control" onChange={(event)=>{setTokenAccountAddress(event.target.value)}} value={tokenAccountAddress}/>
			<span className="input-group-text">Amount</span>
			<input type="Number" className="form-control" onChange={(event)=>{setTokenAmount(parseInt(event.target.value))}} value={tokenAmount}/>
			<button type="button" className="btn btn-primary" disabled={!(wallet && wallet.connected)} onClick={async ()=>{
				await approvedTransferToken(wallet, tokenOwnerAddress, tokenMintAddress, tokenAccountAddress, tokenAmount)
				notify("success", "Approved!")
			}}>Transfer</button>
		</div>
	</div>
	  
}