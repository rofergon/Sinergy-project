declare module "snarkjs" {
  export const groth16: {
    fullProve(
      input: Record<string, unknown>,
      wasmFile: string,
      zkeyFile: string
    ): Promise<{
      proof: {
        pi_a: [string, string, string];
        pi_b: [[string, string], [string, string], [string, string]];
        pi_c: [string, string, string];
      };
      publicSignals: string[];
    }>;
  };
}
