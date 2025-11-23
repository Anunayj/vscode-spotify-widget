const vscode = require('vscode');
const https = require('https');

// Constants
const MAX_SKIP_COUNT = 50;
const SKIP_DELAY_MS = 300;

const path = require('path');
let spotifyPanel = null;
let updateInterval = null;
let accessToken = null;
let tokenExpiresAt = null;
let lastTrackId = null;

// Create output channel for logging
const outputChannel = vscode.window.createOutputChannel('Spotify Widget');

// Try to load robotjs for native media key support
let robot = null;
try {
    robot = require('robotjs');
    outputChannel.appendLine('robotjs loaded successfully');
} catch (error) {
    outputChannel.appendLine(`robotjs not available, will use Web API fallback: ${error.message}`);
}

// Media key mappings for robotjs
const MEDIA_KEYS = {
    'PlayPause': 'audio_play',
    'Next': 'audio_next', 
    'Previous': 'audio_prev'
};


function getClientId() {
    const config = vscode.workspace.getConfiguration('spotifyWidget');
    return config.get('clientId', '');
}

function getRedirectUri() {
    const config = vscode.workspace.getConfiguration('spotifyWidget');
    return config.get('callbackUrl', 'https://anunayj.github.io/vscode-spotify-widget-auth/');
}

const SCOPES = 'user-read-playback-state user-modify-playback-state user-read-currently-playing user-read-playback-position';

function activate(context) {
    outputChannel.appendLine('Spotify Widget extension is now active');
    accessToken = context.globalState.get('spotifyAccessToken');
    tokenExpiresAt = context.globalState.get('spotifyTokenExpiresAt');

    let authCommand = vscode.commands.registerCommand('spotify-widget.authenticate', async function () {
        await authenticateSpotify(context);
    });
    let showCommand = vscode.commands.registerCommand('spotify-widget.show', function () {
        createOrShowSpotifyWidget(context);
    });
    let hideCommand = vscode.commands.registerCommand('spotify-widget.hide', function () {
        if (spotifyPanel) {
            spotifyPanel.dispose();
        }
    });

    context.subscriptions.push(authCommand);
    context.subscriptions.push(showCommand);
    context.subscriptions.push(hideCommand);

    setTimeout(() => {
        createOrShowSpotifyWidget(context);
    }, 1000);
}

async function authenticateSpotify(context) {
    const clientId = getClientId();
    
    if (!clientId) {
        const response = await vscode.window.showInformationMessage(
            'Please set your Spotify Client ID in settings first.',
            'Open Settings'
        );
        if (response === 'Open Settings') {
            vscode.commands.executeCommand('workbench.action.openSettings', 'spotifyWidget.clientId');
        }
        return;
    }
    const redirectUri = getRedirectUri();
    const codeVerifier = generateRandomString(128);
    const codeChallenge = await generateCodeChallenge(codeVerifier);
    const authUrl = `https://accounts.spotify.com/authorize?` +
        `client_id=${clientId}&` +
        `response_type=code&` +
        `redirect_uri=${encodeURIComponent(redirectUri)}&` +
        `scope=${encodeURIComponent(SCOPES)}&` +
        `code_challenge_method=S256&` +
        `code_challenge=${codeChallenge}&` +
        `show_dialog=true`;

    const result = await vscode.window.showInformationMessage(
        'You will be redirected to Spotify to authenticate. After authorizing, copy the code from the page and paste it here.',
        'Open Spotify Login'
    );

    if (result === 'Open Spotify Login') {
        vscode.env.openExternal(vscode.Uri.parse(authUrl));
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        const codeInput = await vscode.window.showInputBox({
            prompt: 'Paste the authorization code from the page',
            placeHolder: 'AQD...',
            ignoreFocusOut: true,
            password: false
        });

        if (codeInput) {
            try {
                const tokens = await exchangeCodeForToken(codeInput.trim(), codeVerifier, clientId);
                
                accessToken = tokens.access_token;
                tokenExpiresAt = Date.now() + (tokens.expires_in * 1000);

                await context.globalState.update('spotifyAccessToken', accessToken);
                await context.globalState.update('spotifyTokenExpiresAt', tokenExpiresAt);

                vscode.window.showInformationMessage('Successfully authenticated with Spotify!');
            } catch (error) {
                vscode.window.showErrorMessage('Authentication failed: ' + error.message);
            }
        }
    }
}

function generateRandomString(length) {
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    const values = crypto.getRandomValues(new Uint8Array(length));
    return values.reduce((acc, x) => acc + possible[x % possible.length], '');
}

async function generateCodeChallenge(codeVerifier) {
    const crypto = require('crypto');
    const hash = crypto.createHash('sha256').update(codeVerifier).digest();
    return base64URLEncode(hash);
}

function base64URLEncode(buffer) {
    return buffer.toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=/g, '');
}

function exchangeCodeForToken(code, codeVerifier, clientId) {
    return new Promise((resolve, reject) => {
        const redirectUri = getRedirectUri();
        const postData = new URLSearchParams({
            client_id: clientId,
            grant_type: 'authorization_code',
            code: code,
            redirect_uri: redirectUri,
            code_verifier: codeVerifier
        }).toString();

        const options = {
            hostname: 'accounts.spotify.com',
            path: '/api/token',
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Content-Length': Buffer.byteLength(postData)
            }
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                if (res.statusCode === 200) {
                    resolve(JSON.parse(data));
                } else {
                    reject(new Error(`Token exchange failed: ${data}`));
                }
            });
        });

        req.on('error', reject);
        req.write(postData);
        req.end();
    });
}

function createOrShowSpotifyWidget(context) {
    if (spotifyPanel) {
        spotifyPanel.reveal(vscode.ViewColumn.Two);
        return;
    }

    spotifyPanel = vscode.window.createWebviewPanel(
        'spotifyWidget',
        'Spotify Player',
        vscode.ViewColumn.Two,
        {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: [vscode.Uri.file(path.join(__dirname, 'assets'))]
        }
    );

    spotifyPanel.webview.html = getWebviewContent();

    spotifyPanel.webview.onDidReceiveMessage(
        async message => {
            switch (message.command) {
                case 'playPause':
                    await sendSpotifyCommand('PlayPause');
                    break;
                case 'next':
                    await sendSpotifyCommand('Next');
                    break;
                case 'previous':
                    await sendSpotifyCommand('Previous');
                    break;
                case 'getCurrentTrack':
                    const trackInfo = await getCurrentTrack();
                    spotifyPanel.webview.postMessage({
                        command: 'updateTrack',
                        data: trackInfo
                    });
                    break;
                case 'getQueue':
                    const queueData = await getQueue();
                    spotifyPanel.webview.postMessage({
                        command: 'updateQueue',
                        data: queueData
                    });
                    break;
                case 'skipToNext':
                    try {
                        await skipToNext();
                        // Refresh both track and queue after skipping
                        const newTrackInfo = await getCurrentTrack();
                        const newQueueData = await getQueue();
                        spotifyPanel.webview.postMessage({
                            command: 'updateTrack',
                            data: newTrackInfo
                        });
                        spotifyPanel.webview.postMessage({
                            command: 'updateQueue',
                            data: newQueueData
                        });
                    } catch (error) {
                        vscode.window.showErrorMessage('Failed to skip track: ' + error.message);
                    }
                    break;
                case 'playFromQueue':
                    try {
                        const { trackUri, queueUris } = message;
                        
                        if (!trackUri || !queueUris || !Array.isArray(queueUris)) {
                            throw new Error('Invalid parameters for playFromQueue');
                        }
                        
                        await playTrackFromQueue(trackUri, queueUris);
                        
                        // Small delay to let Spotify update
                        await new Promise(resolve => setTimeout(resolve, 500));
                        
                        // Refresh both track and queue after playing
                        const newTrackInfo = await getCurrentTrack();
                        const newQueueData = await getQueue();
                        spotifyPanel.webview.postMessage({
                            command: 'updateTrack',
                            data: newTrackInfo
                        });
                        spotifyPanel.webview.postMessage({
                            command: 'updateQueue',
                            data: newQueueData
                        });
                    } catch (error) {
                        vscode.window.showErrorMessage('Failed to play track from queue: ' + error.message);
                    }
                    break;
                case 'skipTracks':
                    try {
                        // Skip multiple times to reach the desired track
                        const skipCount = message.count || 1;
                        
                        // Validate skipCount is a safe positive integer
                        if (typeof skipCount !== 'number' || !Number.isSafeInteger(skipCount) || skipCount <= 0) {
                            throw new Error('Invalid skip count: must be a positive integer greater than zero');
                        }
                        
                        // Limit maximum skips to prevent abuse
                        if (skipCount > MAX_SKIP_COUNT) {
                            throw new Error(`Cannot skip more than ${MAX_SKIP_COUNT} tracks at once`);
                        }
                        
                        for (let i = 0; i < skipCount; i++) {
                            await skipToNext();
                            // Delay between skips (but not after the last one) to avoid rate limiting
                            if (i < skipCount - 1) {
                                await new Promise(resolve => setTimeout(resolve, SKIP_DELAY_MS));
                            }
                        }
                        // Refresh both track and queue after skipping
                        const newTrackInfo = await getCurrentTrack();
                        const newQueueData = await getQueue();
                        spotifyPanel.webview.postMessage({
                            command: 'updateTrack',
                            data: newTrackInfo
                        });
                        spotifyPanel.webview.postMessage({
                            command: 'updateQueue',
                            data: newQueueData
                        });
                    } catch (error) {
                        vscode.window.showErrorMessage('Failed to skip tracks: ' + error.message);
                    }
                    break;
            }
        },
        undefined,
        context.subscriptions
    );
    const config = vscode.workspace.getConfiguration('spotifyWidget');
    const refreshInterval = config.get('refreshInterval', 1000); 

    updateInterval = setInterval(async () => {
        if (spotifyPanel && spotifyPanel.webview) {
            const trackInfo = await getCurrentTrack();
            spotifyPanel.webview.postMessage({
                command: 'updateTrack',
                data: trackInfo
            });
        }
    }, refreshInterval);
    spotifyPanel.onDidDispose(
        () => {
            if (updateInterval) {
                clearInterval(updateInterval);
                updateInterval = null;
            }
            spotifyPanel = null;
        },
        null,
        context.subscriptions
    );
}

async function getCurrentTrack() {
    if (tokenExpiresAt && Date.now() >= tokenExpiresAt) {
        return createEmptyTrackInfo('Token expired', 'Please re-authenticate with Spotify');
    }
    if (!accessToken) {
        return createEmptyTrackInfo('Not authenticated', 'Run "Authenticate with Spotify" command');
    }
    try {
        const data = await spotifyApiRequest('/v1/me/player/currently-playing');

        if (!data || !data.item) {
            return createEmptyTrackInfo('No track playing', 'Start playing music on Spotify');
        }
        const currentTrackId = data.item.id;
        if (lastTrackId !== currentTrackId) {
            lastTrackId = currentTrackId;
        }

        return {
            isPlaying: data.is_playing,
            track: data.item.name,
            artist: data.item.artists.map(a => a.name).join(', '),
            album: data.item.album.name,
            albumArt: data.item.album.images[0]?.url || '',
            progress: data.progress_ms || 0,
            duration: data.item.duration_ms || 0
        };
    } catch (error) {
		vscode.window.showErrorMessage('Spotify API error: ' + error.message);
        
        if (error.message.includes('401')) {
            return createEmptyTrackInfo('Authentication expired', 'Please re-authenticate');
        }
        return createEmptyTrackInfo('Connecting...', 'Loading track info');
    }
}

function spotifyApiRequest(path, method = 'GET', postData = null) {
    return new Promise((resolve, reject) => {
        const options = {
            hostname: 'api.spotify.com',
            path: path,
            method: method,
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json'
            },
            timeout: 5000
        };

        const req = https.request(options, (res) => {
            // 204 No Content and 202 Accepted are success codes for Spotify playback API
            if (res.statusCode === 204 || res.statusCode === 202) {
                resolve(null);
                return;
            }

            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                if (res.statusCode === 200) {
                    try {
                        // Handle empty response body
                        if (!data || data.trim() === '') {
                            resolve(null);
                            return;
                        }
                        resolve(JSON.parse(data));
                    } catch (parseError) {
                        console.error('Failed to parse Spotify API response:', data);
                        reject(new Error(`Failed to parse response: ${parseError.message}`));
                    }
                } else {
                    reject(new Error(`${res.statusCode}: ${data}`));
                }
            });
        });

        req.on('error', reject);
        req.on('timeout', () => {
            req.destroy();
            reject(new Error('Request timeout'));
        });
        
        if (postData) {
            req.write(JSON.stringify(postData));
        }
        req.end();
    });
}

function createEmptyTrackInfo(artist, album) {
    return {
        isPlaying: false,
        track: null,
        artist: artist,
        album: album,
        albumArt: '',
        progress: 0,
        duration: 0,
        error: true
    };
}

async function getQueue() {
    if (!accessToken) {
        return { queue: [], error: 'Not authenticated' };
    }
    
    try {
        const data = await spotifyApiRequest('/v1/me/player/queue');
        
        if (!data) {
            return { queue: [], error: 'No queue available' };
        }
        
        // Format the queue data for the webview
        const queue = data.queue ? data.queue.map(item => ({
            id: item.id || '',
            name: item.name || 'Unknown Track',
            artist: item.artists?.map(a => a.name).join(', ') || 'Unknown Artist',
            album: item.album?.name || 'Unknown Album',
            albumArt: item.album?.images?.[0]?.url || '',
            duration: item.duration_ms || 0,
            uri: item.uri || ''
        })) : [];
        
        return {
            currentlyPlaying: data.currently_playing ? {
                id: data.currently_playing.id || '',
                name: data.currently_playing.name || 'Unknown Track',
                artist: data.currently_playing.artists?.map(a => a.name).join(', ') || 'Unknown Artist',
                album: data.currently_playing.album?.name || 'Unknown Album',
                albumArt: data.currently_playing.album?.images?.[0]?.url || '',
                duration: data.currently_playing.duration_ms || 0,
                uri: data.currently_playing.uri || ''
            } : null,
            queue: queue
        };
    } catch (error) {
        console.error('Error fetching queue:', error);
        return { queue: [], error: error.message };
    }
}

async function skipToNext() {
    if (!accessToken) {
        throw new Error('Not authenticated');
    }
    
    try {
        await spotifyApiRequest('/v1/me/player/next', 'POST');
    } catch (error) {
        console.error('Error skipping to next:', error);
        throw error;
    }
}

async function playTrackFromQueue(trackUri, queueUris) {
    if (!accessToken) {
        throw new Error('Not authenticated');
    }
    
    try {
        // Use the start/resume playback endpoint to play from a specific position in queue
        const body = {
            uris: queueUris,
            offset: {
                uri: trackUri
            }
        };
        
        await spotifyApiRequest('/v1/me/player/play', 'PUT', body);
    } catch (error) {
        console.error('Error playing track from queue:', error);
        throw error;
    }
}

async function sendSpotifyCommand(command) {
    // Try native media key control via robotjs first for minimal latency
    if (robot && MEDIA_KEYS[command]) {
        try {
            robot.keyTap(MEDIA_KEYS[command]);
            outputChannel.appendLine(`Sent ${command} via robotjs media key`);
            return;
        } catch (error) {
            outputChannel.appendLine(`robotjs failed: ${error.message}, falling back to Web API`);
        }
    }

    // Fallback to Spotify Web API
    if (!accessToken) {
        vscode.window.showErrorMessage('Not authenticated with Spotify. Please run "Authenticate with Spotify" command.');
        return;
    }

    try {
        const apiEndpoints = {
            'Next': { path: '/v1/me/player/next', method: 'POST' },
            'Previous': { path: '/v1/me/player/previous', method: 'POST' }
        };

        // For PlayPause, we need to check current state first
        if (command === 'PlayPause') {
            try {
                const currentState = await spotifyApiRequest('/v1/me/player/currently-playing');
                if (currentState && currentState.is_playing) {
                    await spotifyApiRequest('/v1/me/player/pause', 'PUT');
                } else {
                    await spotifyApiRequest('/v1/me/player/play', 'PUT');
                }
            } catch (error) {
                // If current state check fails, try toggling via pause (safer fallback)
                outputChannel.appendLine(`Could not determine playback state: ${error.message}, attempting pause`);
                try {
                    await spotifyApiRequest('/v1/me/player/pause', 'PUT');
                } catch {
                    // If pause also fails, try play as last resort
                    await spotifyApiRequest('/v1/me/player/play', 'PUT');
                }
            }
        } else if (apiEndpoints[command]) {
            const endpoint = apiEndpoints[command];
            await spotifyApiRequest(endpoint.path, endpoint.method);
        }
        outputChannel.appendLine(`Sent ${command} via Spotify Web API`);
    } catch (error) {
        outputChannel.appendLine(`Spotify command failed: ${error.message}`);
        vscode.window.showErrorMessage('Failed to control Spotify. Make sure Spotify is running and you are authenticated.');
    }
}

function getWebviewContent() {
    const fs = require('fs');
    const htmlPath = path.join(__dirname, 'webview.html');
    let html = fs.readFileSync(htmlPath, 'utf8');

    // If a webview panel exists, convert the local asset path to a webview URI
    try {
        const placeholderPath = path.join(__dirname, 'assets', 'placeholder.svg');
        const placeholderUri = spotifyPanel
            ? spotifyPanel.webview.asWebviewUri(vscode.Uri.file(placeholderPath)).toString()
            : '';

        if (placeholderUri) {
            html = html.replace("const placeholderSvg = 'assets/placeholder.svg';", `const placeholderSvg = '${placeholderUri}';`);
        }
    } catch (e) {
        console.error('Failed to convert placeholder path to webview URI:', e);
    }

    return html;
}

function deactivate() {
    if (updateInterval) {
        clearInterval(updateInterval);
    }
    if (outputChannel) {
        outputChannel.dispose();
    }
}

module.exports = {
    activate,
    deactivate
};
