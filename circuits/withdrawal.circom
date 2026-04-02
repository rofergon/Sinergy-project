pragma circom 2.1.6;

include "../node_modules/circomlib/circuits/poseidon.circom";

template WithdrawalClaim(depth) {
    signal input root;
    signal input nullifier;
    signal input recipient;
    signal input token;
    signal input amount;

    signal input secret;
    signal input blinding;
    signal input pathElements[depth];
    signal input pathIndices[depth];

    signal leaf;

    component leafHasher = Poseidon(4);
    leafHasher.inputs[0] <== secret;
    leafHasher.inputs[1] <== blinding;
    leafHasher.inputs[2] <== token;
    leafHasher.inputs[3] <== amount;
    leaf <== leafHasher.out;

    signal hashes[depth + 1];
    hashes[0] <== leaf;
    signal leftInputs[depth];
    signal rightInputs[depth];

    component levelHashers[depth];
    for (var i = 0; i < depth; i++) {
        pathIndices[i] * (pathIndices[i] - 1) === 0;

        leftInputs[i] <== hashes[i] + pathIndices[i] * (pathElements[i] - hashes[i]);
        rightInputs[i] <== pathElements[i] + pathIndices[i] * (hashes[i] - pathElements[i]);

        levelHashers[i] = Poseidon(2);
        levelHashers[i].inputs[0] <== leftInputs[i];
        levelHashers[i].inputs[1] <== rightInputs[i];
        hashes[i + 1] <== levelHashers[i].out;
    }

    hashes[depth] === root;

    component nullifierHasher = Poseidon(2);
    nullifierHasher.inputs[0] <== secret;
    nullifierHasher.inputs[1] <== recipient;
    nullifierHasher.out === nullifier;
}

component main {public [root, nullifier, recipient, token, amount]} = WithdrawalClaim(20);
