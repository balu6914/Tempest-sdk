import { TransactionResponse } from "@ethersproject/abstract-provider";
import { BigNumber, BigNumberish } from "ethers";
import { OrderDirective, PoolDirective } from "../encoding/longform";
import { CrocPoolView } from "../pool";
import { CrocSwapPlan } from "../swap";
import { encodeCrocPrice, tickToPrice } from "../utils";
import { baseTokenForConcLiq, concDepositBalance, quoteTokenForConcLiq } from "../utils/liquidity";


interface RebalanceTarget {
    mint: TickRange
    burn: TickRange
    liquidity: BigNumberish
}

interface RebalanceOpts {
    slippage?: number
}

export class Rebalance {

    constructor (pool: CrocPoolView, target: RebalanceTarget, opts: RebalanceOpts = { }) {
        this.pool = pool
        this.burnRange = target.burn
        this.mintRange = target.mint
        this.liquidity = BigNumber.from(target.liquidity)
        this.spotPrice = this.pool.spotPrice()
        this.spotTick = this.pool.spotTick()
        this.impact = opts.slippage ? opts.slippage : DEFAULT_REBAL_SLIPPAGE
    }

    async rebal(): Promise<TransactionResponse> {        
        const directive = await this.formatDirective()
        return (await this.pool.context).dex.userCmd(LONG_PATH, directive.encodeBytes())
    }

    async simStatic() {
        const directive = await this.formatDirective()
        return (await this.pool.context).dex.callStatic.userCmd(LONG_PATH, directive.encodeBytes())
    }
    
    async balancePercent(): Promise<number> {
        let baseQuoteBal = concDepositBalance(await this.spotPrice, 
            tickToPrice(this.mintRange[0]), tickToPrice(this.mintRange[1]))
        return await this.isBaseOutOfRange() ? 
            (1.0 - baseQuoteBal) : baseQuoteBal
    }

    async currentCollateral(): Promise<BigNumber> {
        let tokenFn = await this.isBaseOutOfRange() ? baseTokenForConcLiq : quoteTokenForConcLiq
        return tokenFn(await this.spotPrice, this.liquidity, 
            tickToPrice(this.burnRange[0]),
            tickToPrice(this.burnRange[1]))
    }

    async convertCollateral(): Promise<BigNumber> {
        let balance = await this.swapFraction()
        let collat = await this.currentCollateral()
        return collat.mul(balance).div(10000)
    }

    async mintInput(): Promise<string> {
        let collat = (await this.currentCollateral()).sub(await this.convertCollateral())
        let pool = (await this.pool)
        return await this.isBaseOutOfRange ?
            (await pool.baseTokenView).toDisplay(collat) :
            (await pool.quoteTokenView).toDisplay(collat)
    }

    async swapOutput(): Promise<string> {
        const [sellToken, buyToken] = await this.pivotTokens()
        
        let swap = new CrocSwapPlan(sellToken, buyToken, await this.convertCollateral(), 
            false, this.impact, (await this.pool).context)
        let impact = await swap.calcImpact()
        return impact.buyQty
    }

    private async isBaseOutOfRange(): Promise<boolean> {
        let spot = await this.spotTick
        if (spot >= this.burnRange[1]) {
            return true
        } else if (spot < this.burnRange[0]) {
            return false
        } else {
            throw new Error("Rebalance position not out of range")
        }
    }

    private async pivotTokens(): Promise<[string, string]> {
        return await this.isBaseOutOfRange() ?
            [this.pool.baseToken, this.pool.quoteToken] :
            [this.pool.quoteToken, this.pool.baseToken]
    }

    private async formatDirective(): Promise<OrderDirective> {
        const [openToken, closeToken] = await this.pivotTokens()
        
        let directive = new OrderDirective(openToken)
        directive.appendHop(closeToken)
        let pool = directive.appendPool((await this.pool.context).chain.poolIndex)

        directive.appendRangeBurn(this.burnRange[0], this.burnRange[1], this.liquidity)
        await this.setupSwap(pool)
        
        directive.appendPool((await this.pool.context).chain.poolIndex)
        let mint = directive.appendRangeMint(this.mintRange[0], this.mintRange[1], 0)
        mint.rollType = 5

        directive.open.limitQty = BigNumber.from(-1000000000000)
        directive.hops[0].settlement.limitQty = BigNumber.from(-10000000000)
        return directive
    }

    private async setupSwap (pool: PoolDirective) {
        pool.chain.swapDefer = true
        pool.swap.rollType = 4
        pool.swap.qty = BigNumber.from(await this.swapFraction())

        const sellBase = await this.isBaseOutOfRange()
        pool.swap.isBuy = sellBase
        pool.swap.inBaseQty = sellBase

        const priceMult = sellBase ? (1 + this.impact) : (1 - this.impact)
        pool.swap.limitPrice = encodeCrocPrice((await this.spotPrice) * priceMult)
    }

    private async swapFraction(): Promise<BigNumber> {
        let swapProp = await this.balancePercent() + this.impact
        return BigNumber.from(Math.floor(Math.min(swapProp, 1.0) * 10000))
    }

    pool: CrocPoolView
    burnRange: TickRange
    mintRange: TickRange
    liquidity: BigNumber
    spotPrice: Promise<number>
    spotTick: Promise<number>
    impact: number
}


type TickRange = [number, number]

const LONG_PATH = 4;
const DEFAULT_REBAL_SLIPPAGE = .02