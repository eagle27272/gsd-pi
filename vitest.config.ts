// Project/App: gsd-pi
// File Purpose: Root vitest config so workspace suites run against package sources instead of unbuilt dist/.
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const srcOf = (pkg: string) => fileURLToPath(new URL(`./packages/${pkg}/src`, import.meta.url));

const piAiSrc = srcOf("pi-ai");
const piAgentCoreSrc = srcOf("pi-agent-core");
const piCodingAgentSrc = srcOf("pi-coding-agent");
const agentCoreSrc = srcOf("gsd-agent-core");
const agentModesSrc = srcOf("gsd-agent-modes");

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		testTimeout: 30000,
		server: {
			deps: {
				external: [/@silvia-odwyer\/photon-node/],
			},
		},
	},
	resolve: {
		// Every @gsd/* workspace package publishes only ./dist/*, which is absent until `pnpm run build:pi`.
		// Point the specifiers at source so a test run needs no prior build of the packages under test.
		alias: [
			{ find: /^@gsd\/pi-ai$/, replacement: `${piAiSrc}/index.ts` },
			{ find: /^@gsd\/pi-ai\/oauth$/, replacement: `${piAiSrc}/oauth.ts` },
			{ find: /^@gsd\/pi-agent-core$/, replacement: `${piAgentCoreSrc}/index.ts` },
			{ find: /^@gsd\/pi-coding-agent$/, replacement: `${piCodingAgentSrc}/index.ts` },
			{ find: /^@gsd\/pi-coding-agent\/(.*)\.js$/, replacement: `${piCodingAgentSrc}/$1.ts` },
			{ find: /^@gsd\/agent-core$/, replacement: `${agentCoreSrc}/index.ts` },
			{ find: /^@gsd\/agent-core\/(.*)\.js$/, replacement: `${agentCoreSrc}/$1.ts` },
			{ find: /^@gsd\/agent-modes$/, replacement: `${agentModesSrc}/index.ts` },
			{ find: /^@gsd\/agent-modes\/(.*)\.js$/, replacement: `${agentModesSrc}/$1.ts` },
		],
	},
});
