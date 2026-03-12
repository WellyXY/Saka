const express = require('express');
const cors = require('cors');
const https = require('https');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

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

app.use(cors());
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
async function fetchUserPostsById(userId, count = 3) {
  try {
    const res = await tikhubGet('/api/v1/instagram/v1/fetch_user_posts', { user_id: userId, count });
    if (res.code !== 200) return [];
    return res.data.items || [];
  } catch (e) {
    return [];
  }
}

// Fetch inspiration posts from followed accounts
async function fetchInspiration(followingList) {
  const inspirationPosts = [];
  // Get posts from up to 10 followed accounts (increased from 5)
  const accountsToFetch = followingList.slice(0, 10);

  console.log(`Fetching inspiration from ${accountsToFetch.length} accounts...`);

  for (const user of accountsToFetch) {
    try {
      // Use user.pk (not user.id) - TikHub API returns pk field
      const posts = await fetchUserPostsById(user.pk, 3);
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
      await new Promise(r => setTimeout(r, 400)); // Rate limit (300-500ms as per Brain's instructions)
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

// Refresh cache
async function refreshCache() {
  if (!TIKHUB_API_KEY) {
    console.log('No TIKHUB_API_KEY, using static data');
    return false;
  }

  const now = Date.now();
  if (cache.lastFetch && (now - cache.lastFetch) < CACHE_TTL) {
    console.log('Using cached data');
    return true;
  }

  try {
    console.log('Fetching fresh data from TikHub...');
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

    cache.lastFetch = now;
    console.log(`Cache refreshed: ${cache.posts.length} posts, ${cache.followers.length} followers, ${cache.following.length} following, ${cache.inspiration.length} inspiration`);
    return true;
  } catch (e) {
    console.error('Error refreshing cache:', e.message);
    return false;
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
    res.json({ success: true, data: cache.inspiration, count: cache.inspiration.length });
  } else {
    res.json({ success: false, error: 'No data available' });
  }
});

app.get('/api/refresh', async (req, res) => {
  cache.lastFetch = null; // Force refresh
  const success = await refreshCache();
  res.json({ success, message: success ? 'Cache refreshed' : 'Failed to refresh' });
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

// Serve index.html for root
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Start server and initial fetch
app.listen(PORT, async () => {
  console.log(`Server running on http://localhost:${PORT}`);
  if (TIKHUB_API_KEY) {
    console.log('TikHub API key found, fetching initial data...');
    await refreshCache();
  } else {
    console.log('No TIKHUB_API_KEY set, using static data only');
  }
});
