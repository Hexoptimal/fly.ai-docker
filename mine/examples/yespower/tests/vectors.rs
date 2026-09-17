//! The reference implementation's own published vectors (yespower's TESTS-OK), so a port that drifts is caught.
use yespower_search::yespower::{yespower, Scratch, Version};

/// The test input the reference uses: src[i] = i * 3, 80 bytes.
fn src() -> Vec<u8> {
    (0..80u32).map(|i| (i * 3) as u8).collect()
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn run(v: Version, n: u32, r: usize, pers: &[u8]) -> String {
    let mut s = Scratch::new(n, r);
    hex(&yespower(&src(), v, n, r, pers, &mut s))
}

#[test]
fn official_vectors() {
    // yespower(0.5, N, r, pers) from TESTS-OK
    assert_eq!(run(Version::V0_5, 2048, 8, b"Client Key"), "a59fec4c4fdda16e3b1405adda66d525b68e7cadfcfe6ac066c7ad118cd80590");
    assert_eq!(run(Version::V0_5, 4096, 16, b"Client Key"), "927e72d0ded3d80475473f40f1743c67289d453d5242d4f55af4e325e06699c5");
    assert_eq!(run(Version::V0_5, 4096, 24, b"Jagaricoin"), "0e13669732 11e7fea8ad9d81989c84a254d968c9d333dd8ff099324f38611e04".replace(' ', ""));
    assert_eq!(run(Version::V0_5, 4096, 32, b"WaviBanana"), "3ae05abb3c5cf6f75415a92554c98d50e38ec9552cfa78373616f480b24e559f");
    assert_eq!(run(Version::V0_5, 2048, 32, b"Client Key"), "560a891b5ca2e1c636111a9ff7c894a5d0a2602f43fdcfa5949b95e22fe4461e");
    assert_eq!(run(Version::V0_5, 1024, 32, b"Client Key"), "2a79e53d1be6669bc556ccc417bce3d22a74a232f56b8e1d39b45792675de108");
    assert_eq!(run(Version::V0_5, 2048, 8, b""), "5ecbd8e8d7c90baed4bbf8916a1225dcc3c65f5c9165bae81cdde3cffad128e8");
    // BSTY passes the source itself as the personalization string
    assert_eq!(run(Version::V0_5, 2048, 8, &src()), "5ea2b2956a9eace30a3237ff1d441edee1dc25aab8f0ea15c12165f83a7bc265");
    // yespower(1.0, N, r, pers)
    assert_eq!(run(Version::V1_0, 2048, 8, b""), "69e0e895b3df7aeeb837d71fe199e9d34f7ec46ecbca7a2c4308e51857ae9b46");
    assert_eq!(run(Version::V1_0, 4096, 16, b""), "33fb8f063824a4a020f63dca535f5ca66ab5576468c75d1ccaac7542f76495ac");
    assert_eq!(run(Version::V1_0, 4096, 32, b""), "771aeefda8fe79a0825bc7f2aee162ab5578574639ffc6ca3723cc18e5e3e285");
    assert_eq!(run(Version::V1_0, 2048, 32, b""), "d5efb813cd263e9b3454013023 3cbbc6a921fbff3431e5ec1a1abde2aea6ff4d".replace(' ', ""));
    assert_eq!(run(Version::V1_0, 1024, 32, b""), "501b792db42e388f6e7d453c95d03a12a36016a5154a688390ddc609a40c6799");
    assert_eq!(run(Version::V1_0, 1024, 32, b"personality test"), "1f0269acf565c49adc0ef9b8f26ab3808cdc38394a254fddeedcc3aacff6ad9d");
}
