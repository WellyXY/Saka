const express = require('express');
const cors = require('cors');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;

// PostgreSQL connection (Railway auto-injects DATABASE_URL)
const pool = process.env.DATABASE_URL ? new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
}) : null;

// Initialize database tables
async function initDB() {
  if (!pool) return;
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS inspiration (
        id TEXT PRIMARY KEY,
        data JSONB NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS rejected_inspirations (
        id TEXT PRIMARY KEY,
        rejected_at TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS content_history (
        id SERIAL PRIMARY KEY,
        data JSONB NOT NULL,
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);
    console.log('PostgreSQL tables initialized');
  } catch (e) {
    console.error('DB init error:', e.message);
  }
}

// TikHub API config
const TIKHUB_API_KEY = process.env.TIKHUB_API_KEY || '';
const TIKHUB_BASE_URL = 'https://api.tikhub.io';
const TARGET_USERNAME = 'saka.yiumo';

// Cache
let cache = {
  profile: null,
  posts: null,
  followers: null,
  following: null,
  inspiration: null,
  lastFetch: null
};
const CACHE_TTL = 30 * 60 * 1000; // 30 minutes

// Persistent data directory (fallback when no DB)
const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || __dirname;
if (DATA_DIR !== __dirname && !fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Persistent data file paths (fallback)
const INSPIRATION_FILE = path.join(DATA_DIR, 'inspiration-saved.json');
const CONTENT_HISTORY_FILE = path.join(DATA_DIR, 'content-history.json');
const REJECTED_INSPIRATIONS_FILE = path.join(DATA_DIR, 'rejected-inspirations.json');
const DATA_JSON_FILE = path.join(__dirname, 'data.json');

// Load fallback data from data.json on startup
function loadFallbackData() {
  try {
    const data = JSON.parse(fs.readFileSync(DATA_JSON_FILE, 'utf8'));
    if (!cache.profile && data.profile) {
      cache.profile = data.profile;
      console.log('Loaded fallback profile from data.json');
    }
    if (!cache.posts && data.posts) {
      cache.posts = data.posts;
      console.log(`Loaded ${data.posts.length} fallback posts from data.json`);
    }
  } catch (e) {
    console.log('No fallback data.json available');
  }
}

// Load inspiration from DB or file (for fast cold starts)
async function loadSavedInspiration() {
  // Try PostgreSQL first
  if (pool) {
    try {
      const result = await pool.query('SELECT data FROM inspiration ORDER BY created_at DESC LIMIT 500');
      if (result.rows.length > 0) {
        cache.inspiration = result.rows.map(r => r.data);
        console.log(`Loaded ${cache.inspiration.length} inspiration posts from PostgreSQL`);
        return true;
      }
    } catch (e) {
      console.error('DB load error:', e.message);
    }
  }
  // Fallback to file
  try {
    const data = JSON.parse(fs.readFileSync(INSPIRATION_FILE, 'utf8'));
    if (Array.isArray(data) && data.length > 0) {
      cache.inspiration = data;
      console.log(`Loaded ${data.length} inspiration posts from file`);
      return true;
    }
  } catch (e) {
    console.log('No saved inspiration available');
  }
  return false;
}

// Save inspiration to DB or file for persistence
async function saveInspiration(inspirationData) {
  // Save to PostgreSQL if available
  if (pool) {
    try {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        for (const item of inspirationData) {
          await client.query(
            'INSERT INTO inspiration (id, data) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET data = $2',
            [item.id, item]
          );
        }
        await client.query('COMMIT');
        console.log(`Saved ${inspirationData.length} inspiration posts to PostgreSQL`);
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
      return;
    } catch (e) {
      console.error('DB save error:', e.message);
    }
  }
  // Fallback to file
  try {
    fs.writeFileSync(INSPIRATION_FILE, JSON.stringify(inspirationData, null, 2));
    console.log(`Saved ${inspirationData.length} inspiration posts to file`);
  } catch (e) {
    console.error('Failed to save inspiration:', e.message);
  }
}

// Helper to load/save rejected IDs
async function loadRejectedIds() {
  if (pool) {
    try {
      const result = await pool.query('SELECT id FROM rejected_inspirations');
      return new Set(result.rows.map(r => r.id));
    } catch (e) {
      console.error('DB load rejected error:', e.message);
    }
  }
  try {
    return new Set(JSON.parse(fs.readFileSync(REJECTED_INSPIRATIONS_FILE, 'utf8')));
  } catch (e) {
    return new Set();
  }
}

async function saveRejectedIds(rejectedSet) {
  if (pool) {
    try {
      await pool.query('DELETE FROM rejected_inspirations');
      for (const id of rejectedSet) {
        await pool.query('INSERT INTO rejected_inspirations (id) VALUES ($1) ON CONFLICT DO NOTHING', [id]);
      }
      return;
    } catch (e) {
      console.error('DB save rejected error:', e.message);
    }
  }
  fs.writeFileSync(REJECTED_INSPIRATIONS_FILE, JSON.stringify([...rejectedSet], null, 2));
}

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// TikHub API helper
function tikhubGet(endpoint, params = {}) {
  return new Promise((resolve, reject) => {
    const qs = new URLSearchParams(params).toString();
    const url = `${TIKHUB_BASE_URL}${endpoint}${qs ? '?' + qs : ''}`;
    https.get(url, { headers: { 'Authorization': `Bearer ${TIKHUB_API_KEY}` } }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('Invalid JSON response')); }
      });
    }).on('error', reject);
  });
}

// Get user ID from username
async function getUserId(username) {
  const res = await tikhubGet('/api/v1/instagram/v1/fetch_user_info_by_username', { username });
  if (res.code !== 200) throw new Error(res.message || 'Failed to get user info');
  return res.data.data.user;
}

// Fetch all posts
async function fetchAllPosts(userId) {
  const allItems = [];
  let nextCursor = null;
  let pageNum = 0;
  const maxPages = 10;

  do {
    pageNum++;
    const params = { user_id: userId, count: 12 };
    if (nextCursor) params.max_id = nextCursor;

    const res = await tikhubGet('/api/v1/instagram/v1/fetch_user_posts', params);
    if (res.code !== 200) break;

    const items = res.data.items || [];
    const seenPks = new Set(allItems.map(i => i.pk));
    const newItems = items.filter(i => !seenPks.has(i.pk));
    allItems.push(...newItems);

    nextCursor = res.data.next_max_id || null;
    if (!res.data.more_available || !nextCursor || newItems.length === 0) break;

    await new Promise(r => setTimeout(r, 300));
  } while (nextCursor && pageNum < maxPages);

  return allItems;
}

// Fetch followers (using v2 API)
async function fetchFollowers(userId) {
  try {
    const res = await tikhubGet('/api/v1/instagram/v2/fetch_user_followers', { user_id: userId, count: 50 });
    if (res.code !== 200) return [];
    return res.data?.data?.items || [];
  } catch (e) {
    console.error('Error fetching followers:', e.message);
    return [];
  }
}

// Fetch following (using v3 API as per Brain's instructions)
async function fetchFollowing(userId, username) {
  try {
    const res = await tikhubGet('/api/v1/instagram/v3/get_user_following', {
      user_id: userId,
      username: username || TARGET_USERNAME,
      count: 50
    });
    if (res.code !== 200 && res.code !== 0) return [];
    return res.data?.users || [];
  } catch (e) {
    console.error('Error fetching following:', e.message);
    return [];
  }
}

// Transform post data for frontend
function transformPost(item, idx) {
  const caption = item.caption ? (item.caption.text || '') : '';
  const isVideo = item.media_type === 2 || item.video_versions;

  // Get thumbnail
  let thumbnail = null;
  if (item.image_versions2 && item.image_versions2.candidates && item.image_versions2.candidates.length > 0) {
    thumbnail = item.image_versions2.candidates[0].url;
  } else if (item.carousel_media && item.carousel_media.length > 0) {
    const c = item.carousel_media[0];
    if (c.image_versions2 && c.image_versions2.candidates.length > 0) {
      thumbnail = c.image_versions2.candidates[0].url;
    }
  }

  return {
    id: item.code || item.pk || `post${idx}`,
    pk: item.pk,
    image: thumbnail,
    caption: caption,
    likes: item.like_count || 0,
    comments: item.comment_count || 0,
    views: item.play_count || item.view_count || 0,
    type: isVideo ? 'Reel' : 'Photo',
    pinned: idx === 0,
    timestamp: item.taken_at
  };
}

// Transform user data for frontend
function transformUser(user) {
  return {
    username: user.username,
    name: user.full_name || user.username,
    avatar: user.profile_pic_url,
    followers: user.follower_count,
    isVerified: user.is_verified
  };
}

// Fetch posts from a user for inspiration feed
async function fetchUserPostsById(userId, count = 12) {
  try {
    const res = await tikhubGet('/api/v1/instagram/v1/fetch_user_posts', { user_id: userId, count });
    if (res.code !== 200) return [];
    return res.data.items || [];
  } catch (e) {
    return [];
  }
}

// Fetch inspiration posts from ALL followed accounts
async function fetchInspiration(followingList) {
  const inspirationPosts = [];
  // Fetch from ALL following accounts
  const accountsToFetch = followingList;

  console.log(`Fetching inspiration from ${accountsToFetch.length} accounts...`);

  for (const user of accountsToFetch) {
    try {
      // Use user.pk (not user.id) - TikHub API returns pk field
      const posts = await fetchUserPostsById(user.pk, 12);
      for (const post of posts) {
        inspirationPosts.push({
          username: user.username,
          name: user.full_name || user.username,
          avatar: user.profile_pic_url,
          image: post.image_versions2?.candidates?.[0]?.url || null,
          caption: post.caption?.text || '',
          time: getTimeAgo(post.taken_at),
          timestamp: post.taken_at, // Store raw timestamp for sorting
          id: post.code || post.pk,
          type: post.media_type === 2 ? 'Reel' : 'Photo',
          likes: post.like_count || 0,
          comments: post.comment_count || 0,
          views: post.play_count || post.view_count || 0
        });
      }
      await new Promise(r => setTimeout(r, 400)); // Rate limit
    } catch (e) {
      console.error('Error fetching posts for', user.username, e.message);
    }
  }

  // Sort by timestamp (most recent first)
  return inspirationPosts.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
}

// Helper to format time ago
function getTimeAgo(timestamp) {
  if (!timestamp) return '';
  const now = Math.floor(Date.now() / 1000);
  const diff = now - timestamp;
  if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
  if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
  if (diff < 604800) return Math.floor(diff / 86400) + 'd ago';
  return Math.floor(diff / 604800) + 'w ago';
}

// Track if background refresh is running
let isRefreshing = false;

// Background refresh (doesn't block requests)
async function backgroundRefresh() {
  if (isRefreshing) return;
  isRefreshing = true;

  try {
    console.log('Background refresh: Fetching fresh data from TikHub...');
    const userInfo = await getUserId(TARGET_USERNAME);

    cache.profile = {
      username: userInfo.username,
      name: userInfo.full_name || 'Yiumo',
      bio: userInfo.biography || '',
      avatar: userInfo.profile_pic_url,
      posts: userInfo.media_count || 0,
      followers: userInfo.follower_count || 0,
      following: userInfo.following_count || 0,
      isVerified: userInfo.is_verified
    };

    const posts = await fetchAllPosts(userInfo.id);
    cache.posts = posts.map((p, i) => transformPost(p, i));

    const followers = await fetchFollowers(userInfo.id);
    cache.followers = followers.map(transformUser);

    const following = await fetchFollowing(userInfo.id, userInfo.username);
    cache.following = following.map(transformUser);

    // Fetch inspiration from followed accounts (use raw following data for user IDs)
    cache.inspiration = await fetchInspiration(following);

    // Save inspiration to file for fast cold starts
    if (cache.inspiration && cache.inspiration.length > 0) {
      saveInspiration(cache.inspiration);
    }

    cache.lastFetch = Date.now();
    console.log(`Background refresh complete: ${cache.posts.length} posts, ${cache.followers.length} followers, ${cache.following.length} following, ${cache.inspiration.length} inspiration`);
  } catch (e) {
    console.error('Background refresh error:', e.message);
  } finally {
    isRefreshing = false;
  }
}

// Refresh cache - returns immediately with stale data if available
async function refreshCache() {
  // Load fallback data first if cache is empty
  if (!cache.posts || !cache.profile) {
    loadFallbackData();
  }

  // Load saved inspiration if not in cache
  if (!cache.inspiration) {
    loadSavedInspiration();
  }

  if (!TIKHUB_API_KEY) {
    console.log('No TIKHUB_API_KEY, using fallback data');
    return cache.posts ? true : false;
  }

  const now = Date.now();
  const cacheAge = cache.lastFetch ? (now - cache.lastFetch) : Infinity;

  // If cache is fresh, use it
  if (cacheAge < CACHE_TTL) {
    return true;
  }

  // If we have stale data, return it immediately and refresh in background
  if (cache.inspiration && cache.inspiration.length > 0) {
    console.log('Returning stale data, triggering background refresh');
    backgroundRefresh(); // Don't await - runs in background
    return true;
  }

  // No cached data at all - must wait for initial fetch
  try {
    console.log('First fetch: Getting initial data from TikHub...');
    const userInfo = await getUserId(TARGET_USERNAME);

    cache.profile = {
      username: userInfo.username,
      name: userInfo.full_name || 'Yiumo',
      bio: userInfo.biography || '',
      avatar: userInfo.profile_pic_url,
      posts: userInfo.media_count || 0,
      followers: userInfo.follower_count || 0,
      following: userInfo.following_count || 0,
      isVerified: userInfo.is_verified
    };

    const posts = await fetchAllPosts(userInfo.id);
    cache.posts = posts.map((p, i) => transformPost(p, i));

    const followers = await fetchFollowers(userInfo.id);
    cache.followers = followers.map(transformUser);

    const following = await fetchFollowing(userInfo.id, userInfo.username);
    cache.following = following.map(transformUser);

    // Fetch inspiration from followed accounts (use raw following data for user IDs)
    cache.inspiration = await fetchInspiration(following);

    // Save inspiration to file for fast cold starts
    if (cache.inspiration && cache.inspiration.length > 0) {
      saveInspiration(cache.inspiration);
    }

    cache.lastFetch = now;
    console.log(`Initial fetch complete: ${cache.posts.length} posts, ${cache.followers.length} followers, ${cache.following.length} following, ${cache.inspiration.length} inspiration`);
    return true;
  } catch (e) {
    console.error('Error in initial fetch:', e.message);
    return cache.posts ? true : false;
  }
}

// API Routes
app.get('/api/profile', async (req, res) => {
  await refreshCache();
  if (cache.profile) {
    res.json({ success: true, data: cache.profile });
  } else {
    res.json({ success: false, error: 'No data available' });
  }
});

app.get('/api/posts', async (req, res) => {
  await refreshCache();
  if (cache.posts) {
    res.json({ success: true, data: cache.posts, count: cache.posts.length });
  } else {
    res.json({ success: false, error: 'No data available' });
  }
});

app.get('/api/followers', async (req, res) => {
  await refreshCache();
  if (cache.followers) {
    res.json({ success: true, data: cache.followers, count: cache.followers.length });
  } else {
    res.json({ success: false, error: 'No data available' });
  }
});

app.get('/api/following', async (req, res) => {
  await refreshCache();
  if (cache.following) {
    res.json({ success: true, data: cache.following, count: cache.following.length });
  } else {
    res.json({ success: false, error: 'No data available' });
  }
});

app.get('/api/inspiration', async (req, res) => {
  await refreshCache();
  if (cache.inspiration) {
    const includeRejected = req.query.includeRejected === 'true';
    const rejectedIds = await loadRejectedIds();

    // Filter out rejected posts unless includeRejected=true
    let filteredData = cache.inspiration;
    if (!includeRejected) {
      filteredData = cache.inspiration.filter(item => !rejectedIds.has(item.id));
    } else {
      // Add rejected flag to items
      filteredData = cache.inspiration.map(item => ({
        ...item,
        rejected: rejectedIds.has(item.id)
      }));
    }

    const page = parseInt(req.query.page) || 1;
    const perPage = parseInt(req.query.perPage) || 30;
    const start = (page - 1) * perPage;
    const end = start + perPage;
    const paginated = filteredData.slice(start, end);
    const totalPages = Math.ceil(filteredData.length / perPage);

    res.json({
      success: true,
      data: paginated,
      count: filteredData.length,
      page,
      perPage,
      totalPages,
      hasMore: page < totalPages
    });
  } else {
    res.json({ success: false, error: 'No data available' });
  }
});

app.get('/api/refresh', async (req, res) => {
  cache.lastFetch = null; // Force refresh
  const success = await refreshCache();
  res.json({ success, message: success ? 'Cache refreshed' : 'Failed to refresh' });
});

// Mark inspiration post as rejected
app.patch('/api/inspiration/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { rejected } = req.body;

    if (typeof rejected !== 'boolean') {
      return res.json({ success: false, error: 'rejected must be a boolean' });
    }

    const rejectedIds = await loadRejectedIds();

    if (rejected) {
      rejectedIds.add(id);
    } else {
      rejectedIds.delete(id);
    }

    await saveRejectedIds(rejectedIds);
    res.json({ success: true, id, rejected });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// Get list of rejected inspiration IDs
app.get('/api/inspiration/rejected', async (req, res) => {
  try {
    const rejectedIds = await loadRejectedIds();
    res.json({ success: true, data: [...rejectedIds], count: rejectedIds.size });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

app.get('/api/status', (req, res) => {
  res.json({
    hasApiKey: !!TIKHUB_API_KEY,
    cacheAge: cache.lastFetch ? Math.round((Date.now() - cache.lastFetch) / 1000) : null,
    postsCount: cache.posts ? cache.posts.length : 0,
    followersCount: cache.followers ? cache.followers.length : 0,
    followingCount: cache.following ? cache.following.length : 0
  });
});

// Agent Task Dashboard
app.get('/api/agents', async (req, res) => {
  try {
    // Read from agents-data.json
    const dataPath = path.join(__dirname, 'agents-data.json');
    const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
    res.json({ success: true, data: data.agents });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// Tasks API - extract tasks from all agents
const AGENTS_DATA_FILE = path.join(__dirname, 'agents-data.json');

app.get('/api/tasks', async (req, res) => {
  try {
    const data = JSON.parse(fs.readFileSync(AGENTS_DATA_FILE, 'utf8'));
    const tasks = [];

    const agentNames = {
      muse: 'Muse',
      echo: 'Echo',
      bolt: 'Bolt',
      saga: 'Saga',
      nova: 'Nova',
      atlas: 'Atlas'
    };

    (data.agents || []).forEach(agent => {
      (agent.tasks || []).forEach((task, idx) => {
        tasks.push({
          id: `${agent.type}-${idx}`,
          title: task.description,
          agent: agentNames[agent.type] || agent.type,
          agentType: agent.type,
          status: task.status === 'completed' ? 'done' : (task.status === 'in_progress' ? 'progress' : 'todo'),
          time: task.time,
          date: task.date
        });
      });
    });

    res.json({ success: true, data: tasks });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// Update agent task (for agents to call)
app.post('/api/tasks/update', (req, res) => {
  try {
    const { agentType, taskIndex, status, description, time } = req.body;
    if (!agentType) {
      return res.json({ success: false, error: 'agentType required' });
    }

    const data = JSON.parse(fs.readFileSync(AGENTS_DATA_FILE, 'utf8'));
    const agent = data.agents.find(a => a.type === agentType);

    if (!agent) {
      return res.json({ success: false, error: 'Agent not found' });
    }

    if (taskIndex !== undefined && agent.tasks[taskIndex]) {
      // Update existing task
      if (status) agent.tasks[taskIndex].status = status;
      if (description) agent.tasks[taskIndex].description = description;
      if (time) agent.tasks[taskIndex].time = time;
    } else if (description) {
      // Add new task
      agent.tasks.unshift({
        date: new Date().toISOString().split('T')[0],
        description,
        status: status || 'in_progress',
        time: time || 'Now'
      });
    }

    fs.writeFileSync(AGENTS_DATA_FILE, JSON.stringify(data, null, 2));
    res.json({ success: true });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// Add task for agent
app.post('/api/tasks/add', (req, res) => {
  try {
    const { agentType, description, status = 'todo' } = req.body;
    if (!agentType || !description) {
      return res.json({ success: false, error: 'agentType and description required' });
    }

    const data = JSON.parse(fs.readFileSync(AGENTS_DATA_FILE, 'utf8'));
    let agent = data.agents.find(a => a.type === agentType);

    if (!agent) {
      // Create agent if not exists
      agent = { type: agentType, status: 'idle', tasks: [] };
      data.agents.push(agent);
    }

    agent.tasks.unshift({
      date: new Date().toISOString().split('T')[0],
      description,
      status,
      time: status === 'in_progress' ? 'Now' : 'Pending'
    });

    fs.writeFileSync(AGENTS_DATA_FILE, JSON.stringify(data, null, 2));
    res.json({ success: true });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// Save inspiration content
app.post('/api/inspiration/save', (req, res) => {
  try {
    const { items } = req.body;
    if (!items || !Array.isArray(items)) {
      return res.json({ success: false, error: 'Invalid items' });
    }

    // Load existing
    let existing = [];
    try {
      existing = JSON.parse(fs.readFileSync(INSPIRATION_FILE, 'utf8'));
    } catch (e) {
      existing = [];
    }

    // Merge (avoid duplicates by id)
    const existingIds = new Set(existing.map(i => i.id));
    const newItems = items.filter(i => !existingIds.has(i.id));
    // Sort all by timestamp (most recent first)
    const merged = [...newItems, ...existing].sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

    fs.writeFileSync(INSPIRATION_FILE, JSON.stringify(merged, null, 2));
    res.json({ success: true, saved: newItems.length, total: merged.length });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// Get saved inspiration with pagination
app.get('/api/inspiration/saved', async (req, res) => {
  try {
    let data = [];
    // Try PostgreSQL first
    if (pool) {
      const result = await pool.query('SELECT data FROM inspiration ORDER BY created_at DESC LIMIT 500');
      data = result.rows.map(r => r.data);
    } else {
      data = JSON.parse(fs.readFileSync(INSPIRATION_FILE, 'utf8'));
    }

    const includeRejected = req.query.includeRejected === 'true';
    const rejectedIds = await loadRejectedIds();

    // Filter out rejected posts unless includeRejected=true
    let filteredData = data;
    if (!includeRejected) {
      filteredData = data.filter(item => !rejectedIds.has(item.id));
    } else {
      filteredData = data.map(item => ({
        ...item,
        rejected: rejectedIds.has(item.id)
      }));
    }

    const page = parseInt(req.query.page) || 1;
    const perPage = parseInt(req.query.perPage) || 30;
    const start = (page - 1) * perPage;
    const end = start + perPage;
    const paginated = filteredData.slice(start, end);
    const totalPages = Math.ceil(filteredData.length / perPage);

    res.json({
      success: true,
      data: paginated,
      count: filteredData.length,
      page,
      perPage,
      totalPages,
      hasMore: page < totalPages
    });
  } catch (e) {
    res.json({ success: true, data: [], count: 0 });
  }
});

// Content history API - with optional refresh
app.get('/api/content-history', (req, res) => {
  try {
    const data = JSON.parse(fs.readFileSync(CONTENT_HISTORY_FILE, 'utf8'));
    res.json({ success: true, data });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// Add content to history
app.post('/api/content-history/add', (req, res) => {
  try {
    const { task } = req.body;
    if (!task) {
      return res.json({ success: false, error: 'No task provided' });
    }

    let history = { tasks: [], inspiration_accounts: [], post_tracking: [] };
    try {
      history = JSON.parse(fs.readFileSync(CONTENT_HISTORY_FILE, 'utf8'));
    } catch (e) {}

    // Add to tasks
    history.tasks = [task, ...(history.tasks || [])];
    history.lastUpdated = new Date().toISOString();

    fs.writeFileSync(CONTENT_HISTORY_FILE, JSON.stringify(history, null, 2));
    res.json({ success: true });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// Update task status
app.post('/api/content-history/status', (req, res) => {
  try {
    const { taskId, status } = req.body;
    if (!taskId || !status) {
      return res.json({ success: false, error: 'taskId and status are required' });
    }

    const validStatuses = ['posted', 'draft', 'rejected'];
    if (!validStatuses.includes(status)) {
      return res.json({ success: false, error: 'Invalid status. Must be: posted, draft, or rejected' });
    }

    let history = { tasks: [] };
    try {
      history = JSON.parse(fs.readFileSync(CONTENT_HISTORY_FILE, 'utf8'));
    } catch (e) {
      return res.json({ success: false, error: 'Content history file not found' });
    }

    const task = history.tasks.find(t => t.id === taskId);
    if (!task) {
      return res.json({ success: false, error: 'Task not found' });
    }

    task.status = status;
    task.status_updated_at = new Date().toISOString();
    history.lastUpdated = new Date().toISOString();

    fs.writeFileSync(CONTENT_HISTORY_FILE, JSON.stringify(history, null, 2));
    res.json({ success: true, task });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// Serve index.html for root
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Start server and initial fetch
app.listen(PORT, async () => {
  console.log(`Server running on http://localhost:${PORT}`);

  // Initialize PostgreSQL tables if connected
  if (pool) {
    console.log('PostgreSQL connected, initializing tables...');
    await initDB();
  }

  // Load fallback data immediately for fast first response
  loadFallbackData();
  await loadSavedInspiration();

  if (TIKHUB_API_KEY) {
    console.log('TikHub API key found, fetching initial data in background...');
    // Don't await - let server start immediately
    refreshCache().catch(e => console.error('Initial fetch error:', e.message));
  } else {
    console.log('No TIKHUB_API_KEY set, using fallback data only');
  }
});
