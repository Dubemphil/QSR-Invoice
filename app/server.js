const puppeteer = require('puppeteer');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const express = require('express');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware to handle request timeouts
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use((req, res, next) => {
    res.setTimeout(600000, () => { // 10-minute timeout
        console.log("Request timed out.");
        res.status(503).send("Service Unavailable: Request timed out.");
    });
    next();
});

async function scrapeInvoiceData(invoiceUrl, sheet2, sheet3) {
    console.log(`Starting scraping process for: ${invoiceUrl}`);

    const browser = await puppeteer.launch({
        headless: true,
        ignoreHTTPSErrors: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-gpu',
            '--disable-dev-shm-usage',
            '--disable-software-rasterizer'
        ]
    });

    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36');
    
    console.log("Navigating to invoice page...");
    await page.goto(invoiceUrl, { waitUntil: 'networkidle2' });

    console.log("Extracting invoice summary...");
    await page.waitForSelector('table');

    const invoiceData = await page.$$eval("table tr", rows => {
        return rows.slice(1, 2).map(row => {
            const cells = row.querySelectorAll("td");
            return {
                businessName: cells[0]?.innerText.trim() || '',
                invoiceNumber: cells[1]?.innerText.trim() || '',
                grandTotal: cells[2]?.innerText.trim() || '',
                vat: cells[3]?.innerText.trim() || '',
                invoiceType: cells[4]?.innerText.trim() || ''
            };
        })[0];
    });

    if (!invoiceData.businessName) {
        console.error("❌ Failed to extract invoice details. Skipping...");
        await browser.close();
        return;
    }

    await sheet2.addRow(Object.values(invoiceData));
    console.log("✅ Invoice data extracted and added to Sheet2:", invoiceData);

    console.log("Extracting invoice items...");
    const invoiceItems = await page.$$eval('li.invoice-item', items => {
        return items.map(item => {
            const getText = (el, selector) => el.querySelector(selector)?.innerText.trim() || '';
            return {
                itemName: getText(item, '.invoice-item-title'),
                unitPrice: getText(item, '.invoice-item-unit-price'),
                quantity: getText(item, '.invoice-item-quantity'),
                totalPrice: getText(item, '.invoice-item-price'),
                beforeVAT: getText(item, '.invoice-item-before-vat'),
                vat: getText(item, '.invoice-item-vat')
            };
        });
    });

    if (invoiceItems.length > 0) {
        const rows = invoiceItems.map(item => [
            invoiceData.businessName,
            invoiceData.invoiceNumber,
            item.itemName,
            item.unitPrice,
            item.quantity,
            item.totalPrice,
            item.beforeVAT,
            item.vat
        ]);

        await sheet3.addRows(rows);
        console.log(`✅ ${invoiceItems.length} invoice items extracted and added to Sheet3.`);
    } else {
        console.log("⚠️ No invoice items found.");
    }

    await browser.close();
    console.log("✅ Scraping completed for:", invoiceUrl);
}

app.get('/scrape', async (req, res) => {
    try {
        const invoiceUrl = req.query.url;
        if (!invoiceUrl) {
            return res.status(400).send("❌ Missing 'url' query parameter.");
        }

        console.log(`Received request to scrape: ${invoiceUrl}`);

        const doc = new GoogleSpreadsheet('YOUR_GOOGLE_SHEET_ID');
        await doc.useServiceAccountAuth(require('./credentials.json'));
        await doc.loadInfo();

        const sheet2 = doc.sheetsByIndex[1];
        const sheet3 = doc.sheetsByIndex[2];

        await scrapeInvoiceData(invoiceUrl, sheet2, sheet3);
        res.send(`✅ Scraping completed for: ${invoiceUrl}`);
    } catch (error) {
        console.error("❌ Error during scraping:", error);
        res.status(500).send("❌ Internal server error.");
    }
});

app.listen(PORT, "0.0.0.0", () => console.log(`✅ Server running on port ${PORT}`));