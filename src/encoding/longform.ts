import { BigNumber, BytesLike, ethers, BigNumberish } from 'ethers';

export class OrderDirective {

    constructor (openToken: string) {
        this.open = simpleSettle(openToken)
        this.hops = []
    }

    encodeBytes(): BytesLike {
        let schema = encodeWord(LONG_FORM_SCHEMA_TYPE)
        let open = encodeSettlement(this.open)
        let hops = listEncoding(this.hops, encodeHop)
        return ethers.utils.concat([schema, open, hops])
    }

    appendHop (nextToken: string): HopDirective {
        const hop = { settlement: simpleSettle(nextToken), 
            pools: [],
            improve: { isEnabled: false, useBaseSide: false } }
        this.hops.push(hop)
        return hop
    }

    appendPool (poolIdx: number): PoolDirective {
        const pool = { 
            poolIdx: poolIdx,
            passive: {
                ambient: { isAdd: false, rollType: 0, liquidity: BigNumber.from(0) },
                concentrated: []
            },
            swap: {
                isBuy: false,
                inBaseQty: false,
                rollType: 0, 
                qty: BigNumber.from(0),
                limitPrice: BigNumber.from(0)
            },
            chain: { rollExit: false, swapDefer: false, offsetSurplus: false}
        };
        (this.hops.at(-1) as HopDirective).pools.push(pool)
        return pool
    }

    appendRangeMint (lowTick: number, highTick: number, liq: BigNumberish): ConcentratedDirective {
        const range = { lowTick: lowTick, highTick: highTick, 
            isRelTick: false, 
            isAdd: true, 
            rollType: 0, 
            liquidity: BigNumber.from(liq).abs()}
        const pool = ((this.hops.at(-1) as HopDirective).pools.at(-1) as PoolDirective)
        pool.passive.concentrated.push(range)
        return range
    }

    appendRangeBurn (lowTick: number, highTick: number, liq: BigNumberish): ConcentratedDirective {
        let range = this.appendRangeMint(lowTick, highTick, liq)
        range.isAdd = false
        return range
    }

    open: SettlementDirective
    hops: HopDirective[]
}

const LONG_FORM_SCHEMA_TYPE = 1

function simpleSettle (token: string): SettlementDirective {
    return { token: token, limitQty: BigNumber.from(2).pow(125),
        dustThresh: BigNumber.from(0), useSurplus: false }
}

interface SettlementDirective {
    token: string
    limitQty: BigNumber,
    dustThresh: BigNumber,
    useSurplus: boolean
}

interface ImproveDirective {
    isEnabled: boolean,
    useBaseSide: boolean
}

interface ChainingDirective {
    rollExit: boolean,
    swapDefer: boolean,
    offsetSurplus: boolean
}

export interface HopDirective {
    pools: PoolDirective[]
    settlement: SettlementDirective
    improve: ImproveDirective
}

export interface PoolDirective {
    poolIdx: BigNumberish
    passive: PassiveDirective,
    swap: SwapDirective
    chain: ChainingDirective
}

interface SwapDirective {
    isBuy: boolean,
    inBaseQty: boolean,
    qty: BigNumber,
    rollType?: number,
    limitPrice: BigNumber
}

interface PassiveDirective {
    ambient: AmbientDirective
    concentrated: ConcentratedDirective[]
}

interface AmbientDirective {
    isAdd: boolean,
    rollType?: number,
    liquidity: BigNumber
}

interface ConcentratedDirective {
    lowTick: number,
    highTick: number,
    isRelTick: boolean,
    isAdd: boolean,
    rollType?: number,
    liquidity: BigNumber
}

function encodeSettlement (dir: SettlementDirective): BytesLike {
    let token = encodeToken(dir.token)
    let limit = encodeFullSigned(dir.limitQty)
    let dust = encodeFull(dir.dustThresh)
    let reserveFlag = encodeWord(dir.useSurplus ? 1 : 0)
    return ethers.utils.concat([token, limit, dust, reserveFlag])
}

function encodeHop (hop: HopDirective): BytesLike {
    let pools = listEncoding(hop.pools, encodePool)
    let settle = encodeSettlement(hop.settlement)
    let improve = encodeImprove(hop.improve)
    return ethers.utils.concat([pools, settle, improve])
}

function encodeImprove (improve: ImproveDirective): BytesLike {
    let flag = (improve.isEnabled ? 2 : 0) + (improve.useBaseSide ? 1 : 0)
    return encodeJsNum(flag, 1)
}

function encodeChain (chain: ChainingDirective): BytesLike {
    let flag = (chain.rollExit ? 4 : 0) + (chain.swapDefer ? 2 : 0) + 
        (chain.offsetSurplus ? 1 : 0)
    return encodeJsNum(flag, 1)
}

function encodePool (pool: PoolDirective): BytesLike {
    let poolIdx = encodeFull(pool.poolIdx)
    let passive = encodePassive(pool.passive)
    let swap = encodeSwap(pool.swap)
    let chain = encodeChain(pool.chain)
    return ethers.utils.concat([poolIdx, passive, swap, chain])
}

function encodeSwap (swap: SwapDirective): BytesLike {
    let dirFlags = encodeWord((swap.isBuy ? 2 : 0) + (swap.inBaseQty ? 1 : 0))
    let rollType = encodeWord(swap.rollType ? swap.rollType : 0)
    let qty = encodeFull(swap.qty)
    let limit = encodeFull(swap.limitPrice)
    return ethers.utils.concat([dirFlags, rollType, qty, limit])
}

function encodePassive (passive: PassiveDirective): BytesLike {
    let ambAdd = encodeBool(passive.ambient.isAdd)
    let rollType = encodeWord(passive.ambient.rollType ? passive.ambient.rollType : 0)
    let ambLiq = encodeFull(passive.ambient.liquidity)
    let conc = listEncoding(passive.concentrated, encodeConc)
    return ethers.utils.concat([ambAdd, rollType, ambLiq, conc])
}

function encodeConc (conc: ConcentratedDirective): BytesLike {
    let openTick = encodeJsSigned(conc.lowTick, 3)
    let closeTick = encodeJsSigned(conc.highTick, 3)
    let isRelTick = encodeBool(conc.isRelTick)
    let isAdd = encodeBool(conc.isAdd)
    let rollType = encodeWord(conc.rollType ? conc.rollType : 0)
    let liq = encodeFull(conc.liquidity)
    return ethers.utils.concat([openTick, closeTick, isRelTick, isAdd, rollType, liq])
}

function listEncoding<T> (elems: T[], encoderFn: (x: T) => BytesLike): BytesLike {
    let count = encodeWord(elems.length)
    let vals = elems.map(encoderFn)
    return ethers.utils.concat([count].concat(vals))
}

function encodeToken (tokenAddr: BytesLike): BytesLike {    
    return ethers.utils.hexZeroPad(tokenAddr, 32)
}

function encodeFull (val: BigNumberish): BytesLike {
    return encodeNum(val, 32)
}

function encodeFullSigned (val: BigNumber): BytesLike {
    return encodeSigned(val, 32)
}

function encodeJsNum (val: number, nWords: number): BytesLike {
    return encodeNum(BigNumber.from(val), nWords)
}

function encodeJsSigned (val: number, nWords: number): BytesLike {
    return encodeSigned(BigNumber.from(val), nWords)
}

function encodeSigned (val: BigNumber, nWords: number): BytesLike {
    let sign = encodeWord(val.lt(0) ? 1 : 0)
    let magn = encodeNum(val.abs(), nWords)
    return ethers.utils.concat([sign, magn])
}

function encodeNum (val: BigNumberish, nWords: number): BytesLike {
    let hex = ethers.utils.hexValue(val)
    return ethers.utils.hexZeroPad(hex, nWords)
}

function encodeWord (val: number): BytesLike {
    return encodeJsNum(val, 1)
}

function encodeBool (flag: boolean): BytesLike {
    return encodeWord(flag ? 1 : 0)
}

