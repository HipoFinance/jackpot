import { CompilerConfig } from '@ton/blueprint'

export const compile: CompilerConfig = {
    lang: 'func',
    targets: ['contracts/upgrade_probe.fc'],
}
