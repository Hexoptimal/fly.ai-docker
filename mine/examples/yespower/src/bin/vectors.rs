//! Checks this port against the reference implementation's published vectors (yespower's TESTS-OK).
//! Built for wasm32-wasip1 and run with node (see check.mjs), because this machine has no native linker.
use yespower_search::yespower::{yespower, Scratch, Version};

fn src() -> Vec<u8> {
    (0..80u32).map(|i| (i * 3) as u8).collect()
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn main() {
    let cases: Vec<(Version, u32, usize, Vec<u8>, &str)> = vec![
        (Version::V0_5, 2048, 8, b"Client Key".to_vec(), "a59fec4c4fdda16e3b1405adda66d525b68e7cadfcfe6ac066c7ad118cd80590"),
        (Version::V0_5, 2048, 8, src(), "5ea2b2956a9eace30a3237ff1d441edee1dc25aab8f0ea15c12165f83a7bc265"),
        (Version::V0_5, 4096, 16, b"Client Key".to_vec(), "927e72d0ded3d80475473f40f1743c67289d453d5242d4f55af4e325e06699c5"),
        (Version::V0_5, 4096, 24, b"Jagaricoin".to_vec(), "0e1366973211e7fea8ad9d81989c84a254d968c9d333dd8ff099324f38611e04"),
        (Version::V0_5, 4096, 32, b"WaviBanana".to_vec(), "3ae05abb3c5cf6f75415a92554c98d50e38ec9552cfa78373616f480b24e559f"),
        (Version::V0_5, 2048, 32, b"Client Key".to_vec(), "560a891b5ca2e1c636111a9ff7c894a5d0a2602f43fdcfa5949b95e22fe4461e"),
        (Version::V0_5, 1024, 32, b"Client Key".to_vec(), "2a79e53d1be6669bc556ccc417bce3d22a74a232f56b8e1d39b45792675de108"),
        (Version::V0_5, 2048, 8, vec![], "5ecbd8e8d7c90baed4bbf8916a1225dcc3c65f5c9165bae81cdde3cffad128e8"),
        (Version::V1_0, 2048, 8, vec![], "69e0e895b3df7aeeb837d71fe199e9d34f7ec46ecbca7a2c4308e51857ae9b46"),
        (Version::V1_0, 4096, 16, vec![], "33fb8f063824a4a020f63dca535f5ca66ab5576468c75d1ccaac7542f76495ac"),
        (Version::V1_0, 4096, 32, vec![], "771aeefda8fe79a0825bc7f2aee162ab5578574639ffc6ca3723cc18e5e3e285"),
        (Version::V1_0, 2048, 32, vec![], "d5efb813cd263e9b34540130233cbbc6a921fbff3431e5ec1a1abde2aea6ff4d"),
        (Version::V1_0, 1024, 32, vec![], "501b792db42e388f6e7d453c95d03a12a36016a5154a688390ddc609a40c6799"),
        (Version::V1_0, 1024, 32, b"personality test".to_vec(), "1f0269acf565c49adc0ef9b8f26ab3808cdc38394a254fddeedcc3aacff6ad9d"),
    ];
    let mut failed = 0;
    for (v, n, r, pers, want) in cases {
        let mut s = Scratch::new(n, r);
        let got = hex(&yespower(&src(), v, n, r, &pers, &mut s));
        let name = format!("yespower({}, {n}, {r}, {})", if v == Version::V0_5 { "0.5" } else { "1.0" },
            if pers.is_empty() { "-".to_string() } else { format!("{} bytes", pers.len()) });
        if got == want {
            println!("ok   {name}");
        } else {
            println!("FAIL {name}\n     want {want}\n     got  {got}");
            failed += 1;
        }
    }
    println!("{}", if failed == 0 { "all vectors match the reference".to_string() } else { format!("{failed} FAILED") });
    if failed > 0 {
        std::process::exit(1);
    }
}
