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

async function generateAbiTypes() {
  const inputDir = path.join(process.cwd(), "abis", "aptos", "testnet");
  const outputDir = path.join(process.cwd(), "src", "abis");

  // Ensure output directory exists
  await fs.mkdir(outputDir, { recursive: true });

  // Read all JSON files in the input directory
  const files = await fs.readdir(inputDir);
  const jsonFiles = files.filter((file) => file.endsWith(".json"));

  for (const jsonFile of jsonFiles) {
    const inputPath = path.join(inputDir, jsonFile);
    const outputPath = path.join(outputDir, jsonFile.replace(".json", ".ts"));

    // Read and parse JSON file
    const jsonContent = await fs.readFile(inputPath, "utf-8");
    const abiEntries: AbiEntry[] = JSON.parse(jsonContent);

    // Generate TypeScript content
    let tsContent = "";

    // Add imports if needed
    tsContent += "// This file is auto-generated. Do not edit manually.\n\n";

    // Generate exports for each ABI entry
    abiEntries.forEach((entry) => {
      const { abi } = entry;
      const exportName = `${abi.name.replace(/[^a-zA-Z0-9_]/g, "_")}_abi`;

      tsContent += `export const ${exportName} = ${JSON.stringify(abi, null, 2)} as const;\n\n`;
    });

    // Write the TypeScript file
    await fs.writeFile(outputPath, tsContent);
    console.log(`Generated ${outputPath}`);
  }
}

// Execute the generation
generateAbiTypes().catch((error) => {
  console.error("Error generating ABI types:", error);
  process.exit(1);
});
