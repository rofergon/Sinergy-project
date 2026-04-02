import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const [, , inputPathArg] = process.argv;
const inputPath = resolve(inputPathArg ?? ".tmp/zk/withdrawal/verification_key.json");

const vk = JSON.parse(await readFile(inputPath, "utf8"));

if (!Array.isArray(vk.IC) || vk.IC.length !== 6) {
  throw new Error("Expected Groth16 verification key with 6 IC points for 5 public inputs");
}

const payload = {
  alpha1: [vk.vk_alpha_1[0], vk.vk_alpha_1[1]],
  beta2: [
    [vk.vk_beta_2[0][1], vk.vk_beta_2[0][0]],
    [vk.vk_beta_2[1][1], vk.vk_beta_2[1][0]]
  ],
  gamma2: [
    [vk.vk_gamma_2[0][1], vk.vk_gamma_2[0][0]],
    [vk.vk_gamma_2[1][1], vk.vk_gamma_2[1][0]]
  ],
  delta2: [
    [vk.vk_delta_2[0][1], vk.vk_delta_2[0][0]],
    [vk.vk_delta_2[1][1], vk.vk_delta_2[1][0]]
  ],
  ic: vk.IC.map((point) => [point[0], point[1]])
};

console.log(JSON.stringify(payload, null, 2));
