// import { before, beforeEach, describe, test } from "node:test";
// import assert from "assert";
// import { TestProcessorServer } from "@sentio/sdk/testing";

// import { MultiRewardsTestReader, resetTestDb } from "../../../processors/multi-rewards-processor.js";
// import { multi_rewards_abi } from "../../../abis/multi-rewards-testnet.js";
// import { TestProcessor } from "../../utils/processor.js";
// import { multiRewardsHandlerIds } from "../common/constants.js";
// import { generateRandomAddress } from "../../common/helpers.js";
// import { verifyPoolState } from "../common/helpers.js";

// describe("Create Staking Pool", async () => {
//   const service = new TestProcessorServer(() => import("../multi-rewards-processor.js"));
//   const processor = new TestProcessor(multi_rewards_abi, multiRewardsHandlerIds, service);
//   const multiRewardsTestReader = new MultiRewardsTestReader();

//   before(async () => {
//     await service.start();
//   });

//   beforeEach(async () => {
//     resetTestDb();
//   });

//   test("Basic Staking Pool Creation", async () => {
//     // Generate test data
//     const poolAddress = generateRandomAddress();
//     const stakingToken = generateRandomAddress();
//     const creator = generateRandomAddress();

//     // Process pool creation event
//     await processor.processEvent({
//       name: "StakingPoolCreatedEvent",
//       data: {
//         pool_address: poolAddress,
//         staking_token: { inner: stakingToken },
//         creator,
//       },
//     });

//     // Verify pool state
//     await verifyPoolState(multiRewardsTestReader, poolAddress, {
//       stakingToken,
//       creator,
//       totalSubscribed: 0n,
//       rewardTokens: [],
//       withdrawalCount: 0,
//       claimCount: 0,
//       subscriberCount: 0,
//     });

//     // Verify module state
//     const module = await multiRewardsTestReader.getModule();
//     assert(module, "Module should exist");
//     assert.strictEqual(module.pool_count, 1);
//   });

//   test("Multiple Pools Same Creator", async () => {
//     // Generate test data
//     const creator = generateRandomAddress();
//     const stakingToken = generateRandomAddress();
//     const pool1Address = generateRandomAddress();
//     const pool2Address = generateRandomAddress();

//     // Process first pool creation event
//     await processor.processEvent({
//       name: "StakingPoolCreatedEvent",
//       data: {
//         pool_address: pool1Address,
//         staking_token: { inner: stakingToken },
//         creator,
//       },
//     });

//     // Process second pool creation event
//     await processor.processEvent({
//       name: "StakingPoolCreatedEvent",
//       data: {
//         pool_address: pool2Address,
//         staking_token: { inner: stakingToken },
//         creator,
//       },
//     });

//     // Verify first pool state
//     await verifyPoolState(multiRewardsTestReader, pool1Address, {
//       stakingToken,
//       creator,
//       totalSubscribed: 0n,
//       rewardTokens: [],
//       withdrawalCount: 0,
//       claimCount: 0,
//       subscriberCount: 0,
//     });

//     // Verify second pool state
//     await verifyPoolState(multiRewardsTestReader, pool2Address, {
//       stakingToken,
//       creator,
//       totalSubscribed: 0n,
//       rewardTokens: [],
//       withdrawalCount: 0,
//       claimCount: 0,
//       subscriberCount: 0,
//     });

//     // Verify pools are distinct
//     const pool1 = await multiRewardsTestReader.getStakingPool(pool1Address);
//     const pool2 = await multiRewardsTestReader.getStakingPool(pool2Address);
//     assert(pool1 && pool2, "Both pools should exist");
//     assert.notStrictEqual(pool1Address, pool2Address, "Pool addresses should be different");

//     // Verify module state reflects two pools
//     const module = await multiRewardsTestReader.getModule();
//     assert(module, "Module should exist");
//     assert.strictEqual(module.pool_count, 2, "Module should track two pools");
//   });
// });
