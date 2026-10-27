import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox'
import '@ton/test-utils'
import { Cell, beginCell, toNano } from '@ton/core'
import { Hipo, deployHipo } from './hipo/deploy'
import { op } from './hipo/common'
import { getConfig } from './hipo/chain'
import { config } from './hipo/common'

function opIs(code: number) {
    return (body: Cell | undefined) => {
        if (body == null) return false
        const s = body.beginParse()
        return s.remainingBits >= 32 && s.loadUint(32) === code
    }
}

describe('Hipo harness', () => {
    let blockchain: Blockchain
    let hipo: Hipo
    let user: SandboxContract<TreasuryContract>

    beforeEach(async () => {
        blockchain = await Blockchain.create()
        hipo = await deployHipo(blockchain)
        user = await blockchain.treasury('user')
    })

    it('mints hGRAM for a GRAM deposit', async () => {
        const fees = await hipo.treasury.getTreasuryFees(0n)
        const amount = toNano('10')
        await hipo.treasury.sendDepositCoins(user.getSender(), { value: amount + fees.depositCoinsFee })
        const wallet = await hipo.walletOf(user.address)
        const [tokens] = await wallet.getWalletState()
        expect(tokens).toBe(amount)
    })

    it('answers provide_current_quote with take_current_quote', async () => {
        const payload = beginCell().storeUint(0xabcdef, 32).endCell()
        const result = await hipo.treasury.sendProvideCurrentQuote(user.getSender(), {
            value: '1',
            queryId: 7n,
            customPayload: payload,
        })
        expect(result.transactions).toHaveTransaction({
            from: hipo.treasury.address,
            to: user.address,
            body: opIs(op.takeCurrentQuote),
        })
        const tx = result.transactions.find(
            (t) => t.inMessage?.info.src?.toString() === hipo.treasury.address.toString(),
        )
        const s = tx!.inMessage!.body.beginParse()
        expect(s.loadUint(32)).toBe(op.takeCurrentQuote)
        expect(s.loadUintBig(64)).toBe(7n)
        const [coins, tokens] = await hipo.quote()
        expect(s.loadUintBig(128)).toBe(coins)
        expect(s.loadUintBig(128)).toBe(tokens)
        expect(s.loadMaybeRef()?.equals(payload)).toBe(true)
    })

    it('raiseRate raises total_coins and leaves total_tokens', async () => {
        const [c0, t0] = await hipo.quote()
        const [c1, t1] = await hipo.raiseRate('5')
        expect(c1).toBe(c0 + toNano('5'))
        expect(t1).toBe(t0)
    })

    it('bounces deposit_coins while stopped', async () => {
        const fees = await hipo.treasury.getTreasuryFees(0n)
        await hipo.setStopped(true)
        const result = await hipo.treasury.sendDepositCoins(user.getSender(), {
            value: toNano('10') + fees.depositCoinsFee,
        })
        expect(result.transactions).toHaveTransaction({
            from: user.address,
            to: hipo.treasury.address,
            body: opIs(op.depositCoins),
            success: false,
        })
        expect(result.transactions).toHaveTransaction({
            from: hipo.treasury.address,
            to: user.address,
            inMessageBounced: true,
        })
        await hipo.setStopped(false)
    })

    it('nextValidationRound moves utime_since forward', async () => {
        const since = () => {
            const s = getConfig(blockchain, config.currentValidators)!.beginParse()
            s.skip(8)
            return s.loadUintBig(32)
        }
        await hipo.nextValidationRound()
        const a = since()
        await hipo.nextValidationRound()
        expect(since()).toBeGreaterThan(a)
        const times = await hipo.treasury.getTimes()
        expect(times.currentRoundSince).toBe(since())
    })
})
