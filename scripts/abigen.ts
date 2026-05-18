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

// Walks abis/aptos/ recursively and emits one src/abis/<basename>.ts per .json file.
// If two .json files in different chain dirs share a basename, the codegen errors
// out so the developer can rename one to disambiguate.
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

  await fs.mkdir(outputDir, { recursive: true });

  const jsonPaths = await findJsonFilesRecursive(inputRoot);

  // Detect basename collisions so we don't silently clobber one chain's ABI
  // with another's.
  const seenByBasename = new Map<string, string>();
  for (const jsonPath of jsonPaths) {
    const basename = path.basename(jsonPath);
    const previous = seenByBasename.get(basename);
    if (previous) {
      const outName = basename.replace(".json", ".ts");
      throw new Error(
        `ABI filename collision: ${previous} and ${jsonPath} would both emit src/abis/${outName}. ` +
          "Rename one to disambiguate (e.g. multi_rewards-movement-mainnet.json).",
      );
    }
    seenByBasename.set(basename, jsonPath);
  }

  for (const inputPath of jsonPaths) {
    const basename = path.basename(inputPath);
    const outputPath = path.join(outputDir, basename.replace(".json", ".ts"));

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
