use chromiumoxide::{Browser, BrowserConfig};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let cfg = BrowserConfig::builder()
        .chrome_executable("/usr/bin/chromium")
        .new_headless_mode()
        .viewport(None)
        .window_size(1280, 800)
        .user_data_dir("/tmp/probe-profile")
        .arg("--disable-gpu")
        .build()?;
    let (browser, handler) = Browser::launch(cfg).await?;
    let h = tokio::spawn(async move {
        let r = handler.run().await;
        eprintln!("handler ended: {:?}", r.err().map(|e| e.to_string()));
    });
    let page = browser.new_page("about:blank").await?;
    let v = page.evaluate("1+1").await?;
    println!("eval: {:?}", v.value());
    let dims = page.evaluate("innerWidth + 'x' + innerHeight").await?;
    println!("window: {:?}", dims.value());
    println!("version: {:?}", browser.version().await?.product);
    let nav = page
        .execute(
            chromiumoxide::cdp::browser_protocol::page::NavigateParams::new(
                "data:text/html,<h1>hi</h1><button>x</button>",
            ),
        )
        .await?;
    println!("nav error_text: {:?}", nav.result.error_text);
    println!("url: {:?}", page.url().await?);
    browser.close().await?;
    let _ = h.await;
    Ok(())
}
