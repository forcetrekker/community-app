/* eslint-disable no-param-reassign */
/**
 * Server-side functions necessary for effective integration with Contentful
 * CMS.
 */

import _ from 'lodash';
import config from 'config';
import fetch from 'isomorphic-fetch';
// import logger from 'utils/logger';
// import moment from 'moment';
import qs from 'qs';
import { logger } from 'topcoder-react-lib';

const contentful = require('contentful-management');
const xml2json = require('xml2json');

/* Holds Contentful CDN URL. */
const CDN_URL = 'https://cdn.contentful.com/spaces';

/* Holds the maximal index age [ms].
 *
 * Set to 1 minute, which means ~100k API requests to Contentful from our dev
 * and prod environments (preview API calls apart, but there should be not that
 * many of them, as the circle of potential editors is edit, compared to that of
 * the regular website visitors).
 */
// const INDEX_MAXAGE = 60 * 1000;

/* Holds Contentful Preview URL. */
const PREVIEW_URL = 'https://preview.contentful.com/spaces';

/* Holds base URL of Community App CDN. */
// const TC_CDN_URL = `${config.CDN.PUBLIC}/contentful`;

export const ASSETS_DOMAIN = 'assets.ctfassets.net';
export const IMAGES_DOMAIN = 'images.ctfassets.net';

const MAX_FETCH_RETRIES = 5;

/* GENERAL-PURPOSE CONTETNFUL API SERVICE. */

/**
 * Given an asset object, replaces its original file URL by URL leading to our
 * own CloudFront CDN.
 *
 * BEWARE:
 *  - It mutates the argument asset.
 *
 * @param {Object} asset
 */
/*
function mapAssetFileUrlToCdn(asset) {
  let x = asset.fields.file.url.split('/');
  switch (x[2]) {
    case ASSETS_DOMAIN:
      x = `${TC_CDN_URL}/assets/${x[4]}/${x[5]}/${x[6]}`;
      break;
    case IMAGES_DOMAIN:
      x = `${TC_CDN_URL}/images/${x[4]}/${x[5]}/${x[6]}`;
      break;
    default: throw new Error('Unexpected asset location');
  }
  asset.fields.file.url = x; // eslint-disable-line no-param-reassign
}
*/

/**
 * Creates a promise that resolves two second after its creation.
 * @return {Promise}
 */
function threeSecondDelay() {
  return new Promise(resolve => setTimeout(resolve, 3000));
}

/**
 * Auxiliary class that handles communication with Contentful CDN and preview
 * APIs in the same uniform manner.
 */
class ApiService {
  /**
   * Creates a new service instance.
   * @param {String} baseUrl The base API endpoint.
   * @param {String} key API key.
   */
  constructor(baseUrl, key) {
    this.private = { baseUrl, key };
  }

  /**
   * Gets data from the specified endpoing.
   * @param {String} endpoint
   * @param {Object} query Optional. URL query to append to the request.
   * @return {Promise}
   */
  async fetch(endpoint, query) {
    let url = `${this.private.baseUrl}${endpoint}`;
    if (query) url += `?${qs.stringify(query)}`;
    let res;
    for (let i = 0; i < MAX_FETCH_RETRIES; i += 1) {
      /* The loop is here to retry async operation multiple times in case of
       * failures due to violation of Contentful API rate limits, which are
       * 78 requests within 1 second. Thus, it is a valid use of await inside
       * loop. */
      /* eslint-disable no-await-in-loop */
      res = await fetch(url, {
        headers: { Authorization: `Bearer ${this.private.key}` },
      });
      /* 429 = "Too Many Requests" */
      if (res.status !== 429) break;
      await threeSecondDelay();
      /* eslint-enable no-await-in-loop */
    }
    if (!res.ok) throw new Error(res.statusText);
    return res.json();
  }

  /**
   * Gets the specified asset.
   * @param {String} id Asset ID.
   * @param {Boolean} mapFileUrlToCdn Optional. Pass in `true` to replace the
   *  actual file path by Community App CDN path.
   * @return {Promise}
   */
  async getAsset(id /* , mapFileUrlToCdn */) {
    const res = await this.fetch(`/assets/${id}`);
    // if (mapFileUrlToCdn) mapAssetFileUrlToCdn(res);
    return res;
  }

  /**
   * Gets the specified content entry.
   * @param {String} id Entry ID.
   * @return {Promise}
   */
  getEntry(id) {
    return this.fetch(`/entries/${id}`);
  }

  /**
   * Queries assets.
   * @param {Object} query Optional. Query.
   * @param {Boolean} mapFileUrlToCdn Optional. Pass in `true` to replace the
   *  actual file path by Community App CDN path.
   * @return {Promise}
   */
  async queryAssets(query /* , mapFileUrlToCdn */) {
    const res = await this.fetch('/assets', query);
    // if (mapFileUrlToCdn) res.items.forEach(x => mapAssetFileUrlToCdn(x));
    return res;
  }

  /**
   * Gets an array of content entries.
   * @param {Object} query Optional. Query for filtering / sorting of entries.
   * @return {Promise}
   */
  queryEntries(query) {
    return this.fetch('/entries', query);
  }
}

/**
 * Updates votes count in Contentful articles
 * @param {Object} body
 * @param {String} body.id
 * @param {Object} body.votes
 */
export function articleVote(body) {
  const client = contentful.createClient({
    accessToken: config.SECRET.CONTENTFUL.MANAGEMENT_TOKEN,
  });
  return client.getSpace(config.SECRET.CONTENTFUL.EDU.SPACE_ID)
    .then(space => space.getEnvironment('master'))
    .then(environment => environment.getEntry(body.id))
    .then((entry) => {
      if (!entry.fields.upvotes) {
        entry.fields.upvotes = {
          'en-US': body.votes.upvotes,
        };
      } else {
        entry.fields.upvotes['en-US'] = body.votes.upvotes;
      }
      if (!entry.fields.downvotes) {
        entry.fields.downvotes = {
          'en-US': body.votes.downvotes,
        };
      } else {
        entry.fields.downvotes['en-US'] = body.votes.downvotes;
      }
      return entry.update();
    })
    .then(entry => entry.publish());
}

/**
 * This function fetches TC RSS feed to create draft articles in THRIVE for the new posted blogs.
 * It calls itself by interval to poll for new blogs.
 * Runs on server side only.
 */
export async function pollArticlesForThrive() {
  // make this function execute only when in production
  if (process.env.BABEL_ENV !== 'production') return;
  logger.log('polling blog articles for THRIVE -> INIT');
  // Create Contentful client to work with
  const client = contentful.createClient({
    accessToken: config.SECRET.CONTENTFUL.MANAGEMENT_TOKEN,
  });
  // connect to Thrive space
  const env = await client.getSpace(config.SECRET.CONTENTFUL.EDU.SPACE_ID)
    .then(space => space.getEnvironment('master'));
  // fetch the poll interval
  const pollConf = await env.getEntry('7n1HT3MhUhgjvCzd36Nymd');
  const pollInt = pollConf ? pollConf.fields.timeInSeconds : 86400; // default to day if not found
  // fetch the RSS feed and parse it
  const feedXML = await fetch(config.URL.THRIVE_POLL_FEED);
  if (feedXML.ok) {
    let feed = await feedXML.text();
    feed = await Promise.resolve(xml2json.toJson(feed, { object: true }));
    if (feed) {
      // when feed loaded and parsed ok
      // apply filter first based on tags work only with 'Community Stories'
      feed.rss.channel.item = _.filter(
        feed.rss.channel.item,
        blogItem => blogItem.category.indexOf('Community Stories') !== -1,
      );
      // loop all feed items and check if those exists in space
      // if not existing then create
      Promise.all(
        _.map(feed.rss.channel.item,
          blogPost => env.getEntries({
            content_type: 'article',
            'fields.title[match]': blogPost.title,
          })
            .then((queryData) => {
              if (queryData.total === 0) {
                // article not found in Contentful space
                // will create it with payload...
                const article = {
                  fields: {
                    title: { 'en-US': blogPost.title },
                    type: { 'en-US': 'Article' },
                    tags: { 'en-US': blogPost.category },
                    creationDate: { 'en-US': new Date(blogPost.pubDate) },
                    content: { 'en-US': blogPost.description },
                    externalArticle: { 'en-US': true },
                    contentUrl: { 'en-US': blogPost.link },
                  },
                };
                // check if author exists
                // if yes link it if no create it?
                return env.getEntries({
                  content_type: 'person',
                  query: blogPost['dc:creator'],
                })
                  .then((author) => {
                    // found an author that matches link it
                    if (author.total) {
                      article.fields.contentAuthor = {
                        'en-US': [{
                          sys: {
                            type: 'Link', linkType: 'Entry', id: author.items[0].sys.id,
                          },
                        }],
                      };
                    }
                    // try get the page to extract its featured image
                    return fetch(blogPost.link)
                      .then(rsp => rsp.text())
                      .then((HTMLsrc) => {
                        const match = /<image [^>]*href="([^"]+)"/gm.exec(HTMLsrc);
                        if (match && match[1]) {
                          // create the asset in Contentful
                          return env.createAsset({
                            fields: {
                              title: { 'en-US': blogPost.title },
                              file: {
                                'en-US': { fileName: blogPost.title, contentType: 'image', upload: match[1] },
                              },
                            },
                          })
                            .then(asset => asset.processForAllLocales())
                            .then((asset) => {
                              article.fields.featuredImage = {
                                'en-US': {
                                  sys: {
                                    type: 'Link', linkType: 'Asset', id: asset.sys.id,
                                  },
                                },
                              };
                              return env.createEntry('article', article);
                            });
                        }
                        // could not find image
                        // just create the article without it...
                        return env.createEntry('article', article);
                      });
                  });
              }
              // Article exists in Contentful space
              // do nothing...
              return 1;
            })),
      )
        .then(() => logger.log('polling blog articles for THRIVE -> DONE'));
    }
  }
  // schedule a repeat each TC_EDU_POLL_TIME
  setTimeout(
    pollArticlesForThrive,
    pollInt * 1000 + (Math.floor(Math.random() * Math.floor(5)) * 60 * 1000),
  ).unref();
}

// /* Contentful CDN service. */
// export const cdnService = new ApiService(CDN_URL, CDN_KEY);

// /* Contentful Preview service. */
// export const previewService = new ApiService(PREVIEW_URL, PREVIEW_KEY);


let services;

function initServiceInstances() {
  const contentfulConfig = config.SECRET.CONTENTFUL;
  services = {};
  _.map(contentfulConfig, (spaceConfig, spaceName) => {
    services[spaceName] = {};
    _.map(spaceConfig, (env, name) => {
      if (name !== 'SPACE_ID') {
        const environment = name;
        const spaceId = spaceConfig.SPACE_ID;
        const previewBaseUrl = `${PREVIEW_URL}/${spaceId}/environments/${environment}`;
        const cdnBaseUrl = `${CDN_URL}/${spaceId}/environments/${environment}`;
        const svcs = {};

        svcs.previewService = new ApiService(previewBaseUrl.toString(), env.PREVIEW_API_KEY);
        svcs.cdnService = new ApiService(cdnBaseUrl.toString(), env.CDN_API_KEY);
        services[spaceName][environment] = svcs;
      }
    });
  });
  return services;
}

/**
 * get space id for the given space name.
 * @param {String} spaceName
 */
export function getSpaceId(spaceName) {
  const name = spaceName || config.CONTENTFUL.DEFAULT_SPACE_NAME;
  return _.get(config, `SECRET.CONTENTFUL.${name}.SPACE_ID`);
}

/**
 * exports Contentful CDN/Preview services.
 * @param {String} spaceName
 * @param {String} environment
 * @param {Boolean} preview
 */
export function getService(spaceName, environment, preview) {
  if (!services) {
    services = initServiceInstances();
  }
  const name = spaceName || config.CONTENTFUL.DEFAULT_SPACE_NAME;
  const env = environment || config.CONTENTFUL.DEFAULT_ENVIRONMENT;

  if (!services[name]) {
    throw new Error(`space : '${name}' is not configured.`);
  }
  if (!services[name][env]) {
    throw new Error(`environment  : '${env}' is not configured for space : '${name}.`);
  }
  const service = services[name][env];
  return preview ? service.previewService : service.cdnService;
}

/**
 * Generates the last version for content index, and other similar data that
 * have to be refreshed regularly to keep us in sync with content edits in CMS.
 * @return {Number}
 */
/*
function getLastVersion() {
  const now = Date.now();
  return now - (now % INDEX_MAXAGE);
}
*/

/**
 * Gets the index of assets and entries via Community App CDN.
 * @param {Number} version Optional. The version of index to fetch. Defaults to
 *  the latest index version.
 * @return {Promise}
 */
/*
async function getIndexViaCdn(version = getLastVersion()) {
  const res = await fetch(`${TC_CDN_URL}/index?version=${version}`);
  if (!res.ok) {
    const MSG = 'Failed to get the index';
    logger.error(MSG, res);
    throw new Error(MSG);
  }
  return res.json();
}
*/

/**
 * Gets the next sync URL via CDN.
 * @param {Number} version Optional. The version of index to fetch. Defaults to
 *  the latest version.
 * @return {Promise}
 */
/*
async function getNextSyncUrlViaCdn(version = getLastVersion()) {
  const res =
    await fetch(`${TC_CDN_URL}/next-sync-url?version=${version}`);
  if (!res.ok) {
    const MSG = 'Failed to get the next sync URL';
    logger.error(MSG, res.statusText);
    throw new Error(MSG);
  }
  return res.text();
}
*/

/* THE INDEX OF CMS ASSETS AND ENTRIES.
 *
 * A tricky logic is involved to keep it all working properly, beware to modify
 * and in all cases prefer to use exported functions that provide access to the
 * index and take care about its correct updating. */

/* The barrier for syncronization of parallel calls to async functions exported
 * by this module. If not null, then it is a promise that signals that the index
 * update is in progress; in this case any function that needs to access the
 * index should wait until the promise is resolved. */
// let barrier = null;

/* Holds the next sync URL provided by the CMS. */
// let nextSyncUrl;

/* The public index of CMS assets and entries. It is the map between CMS IDs of
 * these assets/entries and the timestamps of their last updates. Note that this
 * index is accessible by the frontend via CDN, thus anybody can access it and
 * thus all assets and entries mentioned in this index. That's why announcements
 * with future startDate are not included into this index. */
// let publicIndex;

/**
 * Adds a new asset to the index, or updates the existing one.
 * @param {Object} asset
 */
/*
function indexAsset(asset) {
  const { id, createdAt, updatedAt } = asset.sys;
  publicIndex.assets[id] = moment(updatedAt || createdAt).valueOf();
}
*/

/**
 * Adds a new entry to the index, or updates the existing one.
 * @param {Object} entry
 */
/*
function indexEntry(entry) {
  let isPublic = true;
  const { id, createdAt, updatedAt } = entry.sys;
  const timestamp = moment(updatedAt || createdAt).valueOf();

  const type = entry.sys.contentType.sys.id;
  switch (type) {
    /* We use an additional index of dashboard announcement to be able to find
     * out which announcement should be show at any moment, without a call to
     * CMS. We also do not include future announcements into the public index
     * to avoid any exposure to general public before the time. */
/*
    case 'dashboardAnnouncement': {
      const now = Date.now();
      const endDate = moment(entry.fields.endDate['en-US']).valueOf();
      const startDate = moment(entry.fields.startDate['en-US']).valueOf();
      isPublic = now > startDate;
      if (now < endDate) {
        currentDashboardAnnouncementsMap[id] = {
          id,
          endDate,
          startDate,
          timestamp,
        };
      }
      break;
    }
    default:
  }

  if (isPublic) publicIndex.entries[id] = timestamp;
}
*/

/**
 * Adds a new asset or entry to the index, or updates / removes the existing
 * one.
 * @param {Object} item
 */
/*
function indexItem(item) {
  const { id, type } = item.sys;
  switch (type) {
    case 'Asset': indexAsset(item); break;
    case 'DeletedAsset': delete publicIndex.assets[id]; break;
    case 'DeletedEntry':
      delete currentDashboardAnnouncementsMap[id];
      delete publicIndex.entries[id];
      break;
    case 'Entry': indexEntry(item); break;
    default: throw new Error('Invariant violation');
  }
}
*/

/**
 * Updates the current announcement ID.
 */
/*
function updateCurrentDashboardAnnouncementId() {
  const list = [];
  const now = Date.now();
  Object.values(currentDashboardAnnouncementsMap).forEach((item) => {
    if (item.endDate < now) delete currentDashboardAnnouncementsMap[item.id];
    else if (item.startDate < now) list.push(item);
  });
  if (list.length) {
    list.sort((a, b) => b.startDate - a.startDate);
    currentDashboardAnnouncementId = list[0].id;
  } else currentDashboardAnnouncementId = '';
  if (currentDashboardAnnouncementId
  && (!publicIndex.entries[currentDashboardAnnouncementId])) {
    publicIndex.entries[currentDashboardAnnouncementId] = list[0].timestamp;
  }
}
*/

/**
 * Updates the index.
 * @return {Promise}
 */
/*
async function updateIndex() {
  let nextPageUrl = nextSyncUrl;
  while (nextPageUrl) {
    /* Disabled, as we really need to keep these iterations sequential, thus
     * await inside the loop is not an error. */
/* eslint-disable no-await-in-loop */
/*
    let d = await fetch(nextPageUrl, {
      headers: { Authorization: `Bearer ${CDN_KEY}` },
    });
    if (!d.ok) {
      const MSG = 'Failed to update the index';
      logger.error(MSG, d.statusText);
      throw new Error(MSG);
    }
    d = await d.json();
    /* eslint-anable no-await-in-loop */
/*
    d.items.forEach(indexItem);
    ({ nextPageUrl, nextSyncUrl } = d);
  }
  publicIndex.timestamp = Date.now();
  updateCurrentDashboardAnnouncementId();
}
*/

/**
 * Inits the index with data from CMS.
 * @return {Promise}
 */
/*
async function initIndex() {
  /* Gets necessary data from CMS. */
/*
  let d = await fetch(`${CDN_URL}/sync?initial=true`, {
    headers: { Authorization: `Bearer ${CDN_KEY}` },
  });
  if (!d.ok) {
    const MSG = 'Failed to initialize the index';
    logger.error(MSG, d.statusText);
    throw new Error(MSG);
  }
  d = await d.json();

  /* Generates the index. */
/*
  publicIndex = {
    assets: {},
    entries: {},
  };
  currentDashboardAnnouncementsMap = {};
  d.items.forEach(indexItem);
  publicIndex.timestamp = Date.now();
  updateCurrentDashboardAnnouncementId();

  /* In case the initial update is too large to fit into a single response.
   * TODO: This updateIndex(..) function can be combined with initIndex(..)
   * into a single function. The URL query is the only real difference between
   * them. */
/*
  if (d.nextPageUrl) {
    nextSyncUrl = d.nextPageUrl;
    await updateIndex();
  } else ({ nextSyncUrl } = d);
}
*/

/**
 * Returns the index of CMS assets and content, along with the timestamps of
 * their last updates. This function also takes care about initialization and
 * automatic updates of the index, as necessary.
 * @return {Promise}
 */
/*
export async function getIndex() {
  while (barrier) await barrier;
  if (!publicIndex) barrier = initIndex();
  else if (Date.now() - publicIndex.timestamp > INDEX_MAXAGE) {
    barrier = updateIndex();
  }
  if (barrier) {
    await barrier;
    barrier = null;

    /* These two calls are necessary to cache the updated index by CDN. */
/*
    getIndexViaCdn();
    getCurrentDashboardAnnouncementsIndexViaCdn();
    getNextSyncUrlViaCdn();
  }

  return publicIndex;
}
*/

/**
 * Returns the next sync URL.
 * @return {Promise}
 */
/*
export async function getNextSyncUrl() {
  while (barrier) await barrier;
  if (!publicIndex || Date.now() - publicIndex.timestamp > INDEX_MAXAGE) {
    await getIndex();
  }
  return nextSyncUrl;
}
*/

/* Module initialization.
 * This code tries to pull the current index from CDN, where it is supposed to
 * be cached, to keep it persistent across re-deployments of the app, and also
 * to prevent unnecessary calls to Contentful APIs from a locally deployed
 * server. In case of failure, it initializes the new index using getIndex()
 * function directly. */
/*
let version = Date.now() - INDEX_MAXAGE;
version -= version % INDEX_MAXAGE;
Promise.all([
  getIndexViaCdn(version),
  getCurrentDashboardAnnouncementsIndexViaCdn(version),
  getNextSyncUrl(version),
]).then(([index, dashIndex, next]) => {
  publicIndex = index;
  currentDashboardAnnouncementsMap = dashIndex;
  nextSyncUrl = next;
  updateCurrentDashboardAnnouncementId();
}).catch(() => getIndex());
*/
