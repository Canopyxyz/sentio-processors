// npx tsx ./scripts/abigen.ts

import fs from "fs/promises";
import path from "path";

// - - - - NB: start of copy from surf - - - -

/**
 * The ABI JSON related types.
 */

interface ABIRoot {
  address: string;
  name: string;
  friends: readonly string[];
  exposed_functions: readonly ABIFunction[];
  structs: readonly ABIStruct[];
}

interface ABIFunction {
  name: string;
  visibility: "friend" | "public" | "private";
  is_entry: boolean;
  is_view: boolean;
  generic_type_params: readonly ABIFunctionGenericTypeParam[];
  params: readonly string[];
  return: readonly string[];
}

interface ABIFunctionGenericTypeParam {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constraints: readonly any[];
}

interface ABIStruct {
  name: string;
  is_native: boolean;
  is_event?: boolean; // NOTE: original @thalalabs/surf pkg did not specify this field
  abilities: readonly string[];
  generic_type_params: readonly ABIFunctionGenericTypeParam[];
  fields: readonly ABIStructField[];
}

interface ABIStructField {
  name: string;
  type: string;
}

// - - - - NB: end of copy from surf - - - -

interface AbiEntry {
  bytecode: string;
  abi: ABIRoot;
}

// Walks abis/aptos/<chain>/*.json (any chain subdirectory) and emits one
// src/abis/<name>.ts per JSON file.
//
// Two behaviors worth noting:
//
//  - Files named 0x<hex>.json are skipped. Sentio CLI downloads dependent module
//    ABIs into the same chain subdirectory when codegen needs them (e.g. CLMM
//    helpers referenced by ichi_vault_meridian). We don't bind those in our
//    processors, so we don't need TestProcessor-compatible exports for them.
//
//  - When two JSONs in different chain subdirs share a basename (e.g.
//    multi_rewards.json exists in both testnet and movement-mainnet), the first
//    one in sorted-path order keeps the bare basename so existing imports of
//    src/abis/multi_rewards.js (the testnet flavor) keep working, and the
//    second is automatically renamed to <name>-<chain-dir>.ts. This works even
//    when Sentio CLI re-downloads the file under its default name on each gen.
async function findJsonFilesRecursive(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const results: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await findJsonFilesRecursive(fullPath)));
    } else if (entry.isFile() && entry.name.endsWith(".json")) {
      results.push(fullPath);
    }
  }
  return results;
}

async function generateAbiTypes() {
  const inputRoot = path.join(process.cwd(), "abis", "aptos");
  const outputDir = path.join(process.cwd(), "src", "abis");

  // Clean the output directory before regenerating so stale .ts files (e.g.
  // from a renamed-then-removed JSON in an earlier gen) don't silently linger
  // and shadow what the current generator would emit. src/abis is gitignored,
  // so leftovers can mask import paths that work locally but break on a fresh
  // checkout.
  await fs.rm(outputDir, { recursive: true, force: true });
  await fs.mkdir(outputDir, { recursive: true });

  const allJsonPaths = await findJsonFilesRecursive(inputRoot);

  // Skip dependent-module ABIs that Sentio CLI downloads automatically.
  const jsonPaths = allJsonPaths.filter((p) => !/^0x[0-9a-f]+\.json$/i.test(path.basename(p))).sort();

  // Deterministic disambiguation: first occurrence wins the bare basename;
  // later collisions get suffixed with their parent directory (chain) name.
  const usedOutputNames = new Set<string>();
  for (const inputPath of jsonPaths) {
    const basename = path.basename(inputPath);
    const stem = basename.replace(/\.json$/, "");
    let outStem = stem;
    if (usedOutputNames.has(outStem)) {
      const chainDir = path.basename(path.dirname(inputPath));
      outStem = `${stem}-${chainDir}`;
      if (usedOutputNames.has(outStem)) {
        throw new Error(
          `ABI filename collision could not be auto-resolved for ${inputPath} ` +
            `(would emit ${outStem}.ts which is already taken)`,
        );
      }
    }
    usedOutputNames.add(outStem);

    const outputPath = path.join(outputDir, `${outStem}.ts`);
    const jsonContent = await fs.readFile(inputPath, "utf-8");
    const abiEntries: AbiEntry[] = JSON.parse(jsonContent);

    let tsContent = "// This file is auto-generated. Do not edit manually.\n\n";

    abiEntries.forEach((entry) => {
      const { abi } = entry;
      const exportName = `${abi.name.replace(/[^a-zA-Z0-9_]/g, "_")}_abi`;
      tsContent += `export const ${exportName} = ${JSON.stringify(abi, null, 2)} as const;\n\n`;
    });

    await fs.writeFile(outputPath, tsContent);
    console.log(`Generated ${outputPath}`);
  }
}

// Execute the generation
generateAbiTypes().catch((error) => {
  console.error("Error generating ABI types:", error);
  process.exit(1);
});
