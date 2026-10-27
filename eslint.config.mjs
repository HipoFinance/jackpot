import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import prettier from 'eslint-config-prettier'

export default tseslint.config(
    {
        ignores: ['dist/', 'build/', 'temp/', 'node_modules/', '.claude/'],
    },
    {
        files: ['**/*.ts'],
        extends: [
            js.configs.recommended,
            tseslint.configs.strictTypeChecked,
            tseslint.configs.stylisticTypeChecked,
            prettier,
        ],
        languageOptions: {
            parserOptions: {
                project: ['./tsconfig.json'],
                tsconfigRootDir: import.meta.dirname,
            },
        },
        linterOptions: {
            reportUnusedDisableDirectives: 'error',
        },
    },
    {
        // tests/hipo holds copies of the Hipo contract repo's own wrappers and helpers (see its files), kept
        // as they are there rather than edited here; the rules their originals do not follow are off for them.
        files: ['tests/hipo/**/*.ts'],
        rules: {
            '@typescript-eslint/no-unsafe-enum-assignment': 'off',
            '@typescript-eslint/no-unsafe-assignment': 'off',
            '@typescript-eslint/no-unsafe-argument': 'off',
            '@typescript-eslint/no-unsafe-member-access': 'off',
        },
    },
)
