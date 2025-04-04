import axios from 'axios';
import * as cheerio from 'cheerio';
import sleep from 'sleep-promise';
import randomUseragent from 'random-useragent';
import fs from 'fs';
import { pb } from '../../core/pocketbase';
import { saveModToDatabase } from './saveModsToDatabase';

const baseUrl = 'https://forums.civfanatics.com';
const resourcesUrl = `${baseUrl}/resources/categories/civilization-vii-downloads.181/`;

export interface SyncModVersion {
  version: string;
  date?: string;
  downloadUrl: string;
  downloadCount: string;
  rating: string;
}

export interface SyncMod {
  modName: string;
  modPageUrl: string;
  modAuthor: string;
  updatedAt?: string;
  downloadsCount: string;
  rating: string;
  shortDescription?: string;
  iconUrl?: string;
  versions?: SyncModVersion[];
  releasedAt?: string;
  category?: string;
}

async function getModsFromPage(url: string): Promise<SyncMod[]> {
  const mods: SyncMod[] = [];

  const { data, headers } = await axios.get(url, {
    headers: { 'User-Agent': 'CivMods/1.0' },
  });
  const $ = cheerio.load(data);

  $('.structItem--resource').each((_, element) => {
    const el = $(element);

    const modName = el
      .find('.structItem-title a')
      .text()
      .replace(/\s+/g, ' ')
      .trim();
    const modPageRelativeUrl = el.find('.structItem-title a').attr('href');
    const modPageUrl = baseUrl + modPageRelativeUrl;
    const modAuthor = el.find('.username').first().text().trim();
    const iconUrl = el.find('.structItem-cell--icon a img')?.attr('src');
    const ratingMatch = el
      .find('.ratingStarsRow .ratingStars')
      .attr('title')
      ?.match(/[\d.]+/);
    const rating = ratingMatch ? ratingMatch[0] : 'No rating';
    const shortDescription = el
      .find('.structItem-resourceTagLine')
      .text()
      .replace(/\s+/g, ' ')
      .trim();
    const updatedAt = el
      .find('.structItem-metaItem--lastUpdate time')
      .attr('datetime');
    const downloadsCount = el
      .find('.structItem-metaItem--downloads dd')
      .text()
      .trim();
    const releasedAt = el.find('.structItem-startDate time').attr('datetime');
    const category = el
      .find(
        ".structItem-minor .structItem-parts li a[href^='/resources/categories/']"
      )
      ?.text()
      .trim();

    mods.push({
      modName,
      modPageUrl,
      modAuthor,
      rating,
      shortDescription,
      updatedAt,
      downloadsCount,
      iconUrl,
      releasedAt,
      category,
    });
  });

  return mods;
}

async function getModVersions(historyUrl: string): Promise<SyncModVersion[]> {
  const versions: SyncModVersion[] = [];

  try {
    const { data } = await axios.get(historyUrl, {
      headers: { 'User-Agent': 'CivMods/v0.1.0' },
    });
    const $ = cheerio.load(data);

    $('.dataList-table tbody tr')
      .slice(1)
      .each((_, element) => {
        const el = $(element);

        const version = el.find('td:nth-child(1)').text().trim();
        const date = el.find('td:nth-child(2) time').attr('datetime');
        const downloadCount = el.find('td:nth-child(3)').text().trim();
        const ratingMatch = el
          .find('td:nth-child(4) .ratingStars')
          .attr('title')
          ?.match(/[\d.]+/);
        const rating = ratingMatch ? ratingMatch[0] : 'No rating';
        const downloadRelativeUrl = el.find('td:last-child a').attr('href');
        const downloadUrl = downloadRelativeUrl
          ? baseUrl + downloadRelativeUrl
          : 'No download URL';

        versions.push({
          version,
          date,
          downloadUrl,
          downloadCount,
          rating,
        });
      });
  } catch (error) {
    console.error(`Failed to fetch versions from ${historyUrl}:`, error);
  }

  return versions;
}

// Keeping this function for future use, currently avoiding API calls
async function getSingleMod(url: string): Promise<SyncMod> {
  const { data } = await axios.get(url, {
    headers: { 'User-Agent': 'CivMods/1.0' },
  });
  const $ = cheerio.load(data);

  const modName = $('h1.p-title-value')
    .clone()
    .children('.u-muted')
    .remove()
    .end()
    .text()
    .trim();
  const modPageUrl = url;
  const modAuthor = $('a.username.u-concealed').first().text().trim();
  const iconUrl = $('a.resourceIcon img').attr('src');

  const ratingMatch = $('.ratingStarsRow .ratingStars')
    .attr('title')
    ?.match(/[\d.]+/);
  const rating = ratingMatch ? ratingMatch[0] : 'No rating';

  const shortDescription = $('.resourceBody-description')
    .text()
    .replace(/\s+/g, ' ')
    .trim();

  const updatedAt = $('dl.resourceInfo time.u-dt').first().attr('datetime');

  const downloadsCount = $('dl.resourceInfo dd').eq(1).text().trim();

  const releasedAt = $('dl.resourceInfo time.u-dt').last().attr('datetime');

  const category = $('a[href^="/resources/categories/"]').first().text().trim();

  return {
    modName,
    modPageUrl,
    modAuthor,
    rating,
    shortDescription,
    updatedAt,
    downloadsCount,
    iconUrl,
    releasedAt,
    category,
  };
}

export interface ScrapeModsOptions {
  firstPage?: number;
  maxPages?: number;
  /**
   * Exclusive: Scrape only a single mod by URL.
   * If provided, `firstPage` and `maxPages` are ignored.
   */
  singleModUrl?: string;
  stopAfterLastModVersion?: boolean;
  /** For debugging */
  stopAfterFirstMod?: boolean;
  skipSaveToDatabase?: boolean;
  skipExtractAndStore?: boolean;
  forceExtractAndStore?: boolean;
  /**
   * Skips versions, just global data from the lists (e.g. name).
   * Incompatible with `forceExtractAndStore  and `stopAfterLastModVersion`
   */
  onlyListData?: boolean;
}

export async function scrapeMods(
  options: ScrapeModsOptions
): Promise<SyncMod[]> {
  const {
    maxPages = 15,
    stopAfterFirstMod,
    stopAfterLastModVersion,
    firstPage = 1,
    singleModUrl,
  } = options;

  // Single mod
  if (singleModUrl) {
    console.log(`Scraping single mod: ${singleModUrl}`);

    const mod = await getSingleMod(singleModUrl);

    if (!options.onlyListData) {
      console.log(`Fetching versions for mod: ${mod.modName}`);
      const historyUrl = mod.modPageUrl + '/history';
      mod.versions = await getModVersions(historyUrl);
    }

    console.log(`Mod JSON:`, JSON.stringify(mod, null, 2));

    await saveModToDatabase(options, mod);
    return [mod];
  }

  // limit to avoid long scraping
  const mods: SyncMod[] = [];

  let firstModUrlOnLastPage: string | null = null;

  for (let page = 0; page < maxPages; page++) {
    const pageNumber = page + firstPage;
    const pageUrl =
      pageNumber === 1 ? resourcesUrl : `${resourcesUrl}?page=${pageNumber}`;
    console.log(`Scraping page: ${pageUrl}`);

    const modsOnPage = await getModsFromPage(pageUrl);

    if (modsOnPage[0]?.modPageUrl === firstModUrlOnLastPage) {
      console.log(`Reached last page, stopping scraping`);
      break;
    }

    firstModUrlOnLastPage = modsOnPage[0]?.modPageUrl;

    for (const mod of modsOnPage) {
      // Download mod details (versions)
      if (!options.onlyListData) {
        console.log(`Fetching versions for mod: ${mod.modName}`);
        const historyUrl = mod.modPageUrl + '/history';
        mod.versions = await getModVersions(historyUrl);
      }

      mods.push(mod);

      console.log(`Mod JSON:`, JSON.stringify(mod, null, 2));

      // Save mod
      const shouldStop = await saveModToDatabase(options, mod);
      if (shouldStop) {
        return mods;
      }

      if (stopAfterFirstMod) {
        process.exit(0); // Exit after first mod for testing
      }

      if (!options.onlyListData) {
        const sleepTime = Math.floor(Math.random() * (200 + 1)) + 100; // Random sleep 100-300 ms
        console.log(`Sleeping for ${sleepTime} ms`);
        await sleep(sleepTime);
      }
    }
  }

  return mods;
}
