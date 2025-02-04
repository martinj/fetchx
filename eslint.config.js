import prettier from 'eslint-plugin-prettier';
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
	{
		ignores: ['**/*.d.ts', 'dist']
	},
	{
		files: ['**/*.ts'],
		extends: [eslint.configs.recommended, ...tseslint.configs.recommended],
		plugins: {
			prettier
		},
		rules: {
			'prettier/prettier': 2,
			'@typescript-eslint/ban-ts-comment': 0
		}
	}
);
