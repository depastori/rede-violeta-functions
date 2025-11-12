(import { Hono } from 'npm:hono@4.6.14';
import { cors } from 'npm:hono/cors';
import { logger } from 'npm:hono/logger';
import * as kv from './kv_store.tsx';
const app = new Hono();

// LOG de carregamento do módulo para confirmar deploy
console.log('MODULE DEPLOYED: make-server-370b3cd1 - ' + new Date().toISOString());

// ============================================================================
// HELPER: Extract session token (aceita x-client-info, X-Session-Token ou Authorization Bearer UUID)
// ============================================================================
function getSessionToken(c) {
  // Prioridade: x-client-info (adicionado porque Supabase edge aceita esse header)
  const clientInfo = c.req.header('x-client-info') || c.req.header('X-Client-Info');
  if (clientInfo) return clientInfo;

  // Em seguida: X-Session-Token (mantendo compatibilidade com código anterior)
  const customToken = c.req.header('X-Session-Token') || c.req.header('x-session-token');
  if (customToken) return customToken;

  // Fallback: Authorization: Bearer <token>
  const authHeader = c.req.header('Authorization') || c.req.header('authorization') || '';
  if (authHeader && typeof authHeader === 'string') {
    const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
    // Se o token não for a anon key e não tiver formato JWT (com '.') tratar como nosso UUID
    if (bearer && bearer !== anonKey && !bearer.includes('.')) {
      return bearer;
    }
  }

  return null;
}

// ============================================================================
// CORS - MUST BE FIRST
// ============================================================================
app.use('*', cors({
  origin: '*',
  allowMethods: [
    'GET',
    'POST',
    'PUT',
    'DELETE',
    'OPTIONS'
  ],
  allowHeaders: [
    'Content-Type',
    'X-Session-Token',
    'x-client-info',
    'Authorization'
  ],
  credentials: true
}));
app.use('*', logger(console.log));

// ============================================================================
// HEALTH CHECK
// ============================================================================
app.get('/make-server-370b3cd1/health', (c)=>{
  return c.json({
    status: 'ok',
    version: '18.0',
    timestamp: new Date().toISOString()
  });
});

// ============================================================================
// AUTH: LOGIN
// ============================================================================
app.post('/make-server-370b3cd1/auth/login', async (c)=>{
  try {
    const { email } = await c.req.json();
    if (!email) return c.json({
      error: 'Email required'
    }, 400);
    let userId = await kv.get(`user_by_email:${email}`);
    let userData;
    if (!userId) {
      userId = crypto.randomUUID();
      userData = {
        id: userId,
        name: email.split('@')[0],
        email,
        isVerified: false,
        createdAt: new Date().toISOString(),
        profile: {}
      };
      await kv.set(`user:${userId}`, userData);
      await kv.set(`user_by_email:${email}`, userId);
    } else {
      userData = await kv.get(`user:${userId}`);
    }
    const sessionToken = crypto.randomUUID();
    await kv.set(`session:${sessionToken}`, {
      token: sessionToken,
      userId: userId,
      createdAt: new Date().toISOString()
    });
    return c.json({
      success: true,
      user: userData,
      session: {
        access_token: sessionToken,
        user: {
          id: userId,
          email: userData.email
        }
      }
    });
  } catch (error) {
    console.log('Login error:', error);
    return c.json({
      error: 'Login failed'
    }, 500);
  }
});

// ============================================================================
// PROFILE: UPDATE
// ============================================================================
app.put('/make-server-370b3cd1/user/profile', async (c)=>{
  try {
    // LOG visível para confirmar deploy e execução dessa rota
    console.log('DEPLOY-CHECK: make-server-370b3cd1 PUT /user/profile - ' + new Date().toISOString());

    const accessToken = getSessionToken(c);
    console.log('SESSION TOKEN RECEIVED:', accessToken);

    if (!accessToken) return c.json({
      error: 'Authentication required'
    }, 401);

    const sessions = await kv.getByPrefix('session:') || [];
    const userSession = sessions.find((s)=>s.token === accessToken);
    if (!userSession) {
      console.log('Invalid session for token:', accessToken);
      return c.json({
        error: 'Invalid session'
      }, 401);
    }

    const body = await c.req.json();
    const userData = await kv.get(`user:${userSession.userId}`);
    if (!userData) return c.json({
      error: 'User not found'
    }, 404);
    userData.profile = {
      ...userData.profile,
      ...body
    };
    await kv.set(`user:${userSession.userId}`, userData);
    return c.json({
      success: true,
      profile: userData.profile
    });
  } catch (error) {
    console.log('Profile update error:', error);
    return c.json({
      error: 'Update failed'
    }, 500);
  }
});

// ============================================================================
// PROFILE: GET
// ============================================================================
app.get('/make-server-370b3cd1/user/profile/:userId', async (c)=>{
  try {
    const userId = c.req.param('userId');
    const userData = await kv.get(`user:${userId}`);
    if (!userData) return c.json({
      error: 'User not found'
    }, 404);
    return c.json({
      success: true,
      profile: {
        id: userData.id,
        userName: userData.profile?.userName || userData.name,
        photoUrl: userData.profile?.photoUrl,
        bio: userData.profile?.bio,
        isVolunteer: userData.profile?.isVolunteer,
        volunteerServices: userData.profile?.volunteerServices,
        isVerified: userData.isVerified,
        privacySettings: userData.profile?.privacySettings
      }
    });
  } catch (error) {
    return c.json({
      error: 'Failed to fetch profile'
    }, 500);
  }
});

// ============================================================================
// CONNECTIONS: GET ALL
// ============================================================================
app.get('/make-server-370b3cd1/user/connections', async (c)=>{
  try {
    const accessToken = getSessionToken(c);
    if (!accessToken) return c.json({
      error: 'Authentication required'
    }, 401);
    const sessions = await kv.getByPrefix('session:') || [];
    const userSession = sessions.find((s)=>s.token === accessToken);
    if (!userSession) return c.json({
      error: 'Invalid session'
    }, 401);
    const allConnections = await kv.getByPrefix('connection:') || [];
    const userConnections = allConnections.filter((conn)=>{
      if (conn.status !== 'accepted') return false;
      return conn.requestedBy === userSession.userId || conn.targetUserId === userSession.userId;
    });
    const connectionsWithDetails = await Promise.all(userConnections.map(async (conn)=>{
      const otherUserId = conn.requestedBy === userSession.userId ? conn.targetUserId : conn.requestedBy;
      const otherUser = await kv.get(`user:${otherUserId}`);
      return {
        userId: otherUserId,
        userName: otherUser?.profile?.userName || otherUser?.name || 'Unknown',
        photoUrl: otherUser?.profile?.photoUrl || '',
        bio: otherUser?.profile?.bio || '',
        isPersonal: conn.isPersonal || false,
        connectedAt: conn.acceptedAt,
        personalConfirmedBy: conn.personalConfirmedBy || []
      };
    }));
    return c.json({
      success: true,
      connections: connectionsWithDetails,
      stats: {
        total: connectionsWithDetails.length,
        personal: connectionsWithDetails.filter((c)=>c.isPersonal).length
      }
    });
  } catch (error) {
    return c.json({
      error: 'Failed to fetch connections'
    }, 500);
  }
});

// ============================================================================
// CONNECTIONS: GET PENDING
// ============================================================================
app.get('/make-server-370b3cd1/user/connections/pending', async (c)=>{
  try {
    const accessToken = getSessionToken(c);
    if (!accessToken) return c.json({
      error: 'Authentication required'
    }, 401);
    const sessions = await kv.getByPrefix('session:') || [];
    const userSession = sessions.find((s)=>s.token === accessToken);
    if (!userSession) return c.json({
      error: 'Invalid session'
    }, 401);
    const allConnections = await kv.getByPrefix('connection:') || [];
    const pendingConnections = allConnections.filter((conn)=>{
      if (conn.status !== 'pending') return false;
      return conn.requestedBy === userSession.userId || conn.targetUserId === userSession.userId;
    });
    const received = [];
    const sent = [];
    for (const conn of pendingConnections){
      const otherUserId = conn.requestedBy === userSession.userId ? conn.targetUserId : conn.requestedBy;
      const otherUser = await kv.get(`user:${otherUserId}`);
      const request = {
        userId: otherUserId,
        userName: otherUser?.profile?.userName || otherUser?.name || 'Unknown',
        photoUrl: otherUser?.profile?.photoUrl || '',
        requestedAt: conn.requestedAt
      };
      if (conn.requestedBy === userSession.userId) {
        sent.push(request);
      } else {
        received.push(request);
      }
    }
    return c.json({
      success: true,
      pending: {
        received,
        sent
      }
    });
  } catch (error) {
    return c.json({
      error: 'Failed to fetch pending connections'
    }, 500);
  }
});

// ============================================================================
// CONNECTIONS: SEND REQUEST
// ============================================================================
app.post('/make-server-370b3cd1/user/connections/request', async (c)=>{
  try {
    const accessToken = getSessionToken(c);
    if (!accessToken) return c.json({
      error: 'Authentication required'
    }, 401);
    const sessions = await kv.getByPrefix('session:') || [];
    const userSession = sessions.find((s)=>s.token === accessToken);
    if (!userSession) return c.json({
      error: 'Invalid session'
    }, 401);
    const { targetUserId } = await c.req.json();
    if (!targetUserId) return c.json({
      error: 'Target user required'
    }, 400);
    if (targetUserId === userSession.userId) return c.json({
      error: 'Cannot connect to yourself'
    }, 400);
    const connectionKey = targetUserId < userSession.userId ? `connection:${targetUserId}:${userSession.userId}` : `connection:${userSession.userId}:${targetUserId}`;
    const existing = await kv.get(connectionKey);
    if (existing) return c.json({
      error: 'Connection already exists'
    }, 400);
    const connection = {
      status: 'pending',
      requestedBy: userSession.userId,
      targetUserId: targetUserId,
      requestedAt: new Date().toISOString(),
      isPersonal: false
    };
    await kv.set(connectionKey, connection);
    return c.json({
      success: true,
      connection
    });
  } catch (error) {
    return c.json({
      error: 'Failed to send request'
    }, 500);
  }
});

// ============================================================================
// CONNECTIONS: ACCEPT
// ============================================================================
app.put('/make-server-370b3cd1/user/connections/accept', async (c)=>{
  try {
    const accessToken = getSessionToken(c);
    if (!accessToken) return c.json({
      error: 'Authentication required'
    }, 401);
    const sessions = await kv.getByPrefix('session:') || [];
    const userSession = sessions.find((s)=>s.token === accessToken);
    if (!userSession) return c.json({
      error: 'Invalid session'
    }, 401);
    const { requestUserId } = await c.req.json();
    if (!requestUserId) return c.json({
      error: 'Request user required'
    }, 400);
    const connectionKey = requestUserId < userSession.userId ? `connection:${requestUserId}:${userSession.userId}` : `connection:${userSession.userId}:${requestUserId}`;
    const connection = await kv.get(connectionKey);
    if (!connection) return c.json({
      error: 'Connection not found'
    }, 404);
    if (connection.status === 'accepted') return c.json({
      error: 'Already accepted'
    }, 400);
    connection.status = 'accepted';
    connection.acceptedAt = new Date().toISOString();
    await kv.set(connectionKey, connection);
    return c.json({
      success: true,
      connection
    });
  } catch (error) {
    return c.json({
      error: 'Failed to accept'
    }, 500);
  }
});

// ============================================================================
// USER SEARCH
// ============================================================================
app.post('/make-server-370b3cd1/user/search', async (c)=>{
  try {
    const accessToken = getSessionToken(c);
    if (!accessToken) return c.json({
      error: 'Authentication required'
    }, 401);
    const sessions = await kv.getByPrefix('session:') || [];
    const userSession = sessions.find((s)=>s.token === accessToken);
    if (!userSession) return c.json({
      error: 'Invalid session'
    }, 401);
    const { query } = await c.req.json();
    if (!query || query.trim().length < 2) return c.json({
      error: 'Query too short'
    }, 400);
    const allUsers = await kv.getByPrefix('user:') || [];
    const searchTerm = query.toLowerCase().trim();
    const matchingUsers = allUsers.filter((userData)=>{
      if (userData.id === userSession.userId) return false;
      const userName = (userData.profile?.userName || userData.name || '').toLowerCase();
      return userName.includes(searchTerm);
    }).slice(0, 20).map((userData)=>({
        id: userData.id,
        userName: userData.profile?.userName || userData.name,
        photoUrl: userData.profile?.photoUrl,
        bio: userData.profile?.bio,
        isVolunteer: userData.profile?.isVolunteer || false
      }));
    return c.json({
      success: true,
      users: matchingUsers
    });
  } catch (error) {
    return c.json({
      error: 'Search failed'
    }, 500);
  }
});

Deno.serve(app.fetch);)
