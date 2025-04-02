const { google } = require('googleapis');
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

// Set up Google Sheets API credentials
const auth = new google.auth.GoogleAuth({
  keyFile: 'path_to_your_credentials.json',  // Replace with your actual credentials JSON file path
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

// Define spreadsheet ID
const SPREADSHEET_ID = 'your_spreadsheet_id'; // Replace with your actual spreadsheet ID

// Function to get the URL from Sheet1, Column 2 (Column B)
const getURLFromSheet = async () => {
  const sheets = google.sheets({ version: 'v4', auth });
  const range = 'Sheet1!B2';  // Sheet1, Column 2 (B2)
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: range,
  });

  const url = response.data.values ? response.data.values[0][0] : null;
  return url;
};

// Function to scrape data from the URL
const scrapeData = async (url) => {
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
  await page.goto(url, { waitUntil: 'networkidle2' });

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
  console.log("✅ Scraping completed for:", url);
}

// Function to update Sheet2 and Sheet3 with the scraped data
const updateSheet = async (range, data) => {
  const sheets = google.sheets({ version: 'v4', auth });

  // Write to Sheet2 (you can modify this based on the data structure)
  const sheet2Range = `${range}Sheet2!A2`;  // Adjust this range accordingly
  const resourceSheet2 = {
    values: [
      [data.title, data.content], // Example: Write title and content to Sheet2
    ],
  };
  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: sheet2Range,
    valueInputOption: 'RAW',
    resource: resourceSheet2,
  });

  // Write to Sheet3
  const sheet3Range = `${range}Sheet3!A2`;  // Adjust this range accordingly
  const resourceSheet3 = {
    values: [
      [data.title, data.content], // Example: Write title and content to Sheet3
    ],
  };
  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: sheet3Range,
    valueInputOption: 'RAW',
    resource: resourceSheet3,
  });
};

// Express route to scrape data and update sheets
app.get('/scrape', async (req, res) => {
  try {
    const invoiceUrl = await getURLFromSheet(); // Get URL from Google Sheets
    if (!invoiceUrl) {
      return res.status(400).send("❌ No URL found in Sheet1, Column 2");
    }

    console.log(`Received request to scrape: ${invoiceUrl}`);

    const doc = new GoogleSpreadsheet(SPREADSHEET_ID);
    await doc.useServiceAccountAuth(require('./credentials.json'));
    await doc.loadInfo();

    const sheet2 = doc.sheetsByIndex[1];
    const sheet3 = doc.sheetsByIndex[2];

    // Scrape invoice data from the URL
    await scrapeInvoiceData(invoiceUrl, sheet2, sheet3);
    res.send(`✅ Scraping completed for: ${invoiceUrl}`);
  } catch (error) {
    console.error("❌ Error during scraping:", error);
    res.status(500).send("❌ Internal server error.");
  }
});

// Start the server
app.listen(PORT, "0.0.0.0", () => console.log(`✅ Server running on port ${PORT}`));
