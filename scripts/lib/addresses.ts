import { Address } from '@ton/core'

// Mainnet addresses the scripts work with. They mirror the Hipo contract repo's README ("Deployed contracts")
// and the burner repo's wrappers/addresses.ts, and are only defaults: every script shows what it will use.

/** Hipo's treasury. */
export const HIPO_TREASURY = Address.parse('EQCLyZHP4Xe8fpchQz76O-_RmUhaVc_9BAoGyJrwJrcbz2eZ')

/** Hipo's parent, which is also the hGRAM jetton master. */
export const HIPO_PARENT = Address.parse('EQDPdq8xjAhytYqfGSX8KcFWIReCufsB9Wdg0pLlYSO_h76w')

/** The HPO burner. */
export const BURNER = Address.parse('EQDcjZDWvotoVE0X4HSdt2pR3b2sBZ4XikzSVSdPiqdQMLRK')
