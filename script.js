// Elements
const inputSection = document.getElementById('input-section');
const loadingSection = document.getElementById('loading-section');
const resultSection = document.getElementById('result-section');
const loadingText = document.getElementById('loading-text');
const errorMsg = document.getElementById('error-msg');
const generateBtn = document.getElementById('generate-btn');

let currentPlaylistText = "";
let currentYoutubeUrl = "";
let oauthAccessToken = null;

function showError(msg) {
    errorMsg.textContent = msg;
    errorMsg.style.display = 'block';
    resetState();
}

function hideError() {
    errorMsg.style.display = 'none';
    errorMsg.textContent = '';
}

function updateLoadingText(msg) {
    loadingText.textContent = msg;
}

function resetState() {
    generateBtn.disabled = false;
    generateBtn.innerHTML = '<svg class="icon" viewBox="0 0 24 24"><path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg> Google 인증 및 플레이리스트 생성';
    loadingSection.style.display = 'none';
    inputSection.style.display = 'block';
}

// Initialize OAuth and trigger flow
function initOAuthAndGenerate() {
    const songs = document.getElementById('song-input').value.trim();
    const geminiKey = document.getElementById('gemini-key').value.trim();
    const clientId = document.getElementById('google-client-id').value.trim();

    if (!songs) return showError('노래를 한 곡 이상 입력해주세요.');
    if (!geminiKey) return showError('Gemini API Key를 입력해주세요.');
    if (!clientId) return showError('Google OAuth Client ID를 입력해주세요.');

    hideError();
    generateBtn.disabled = true;
    generateBtn.textContent = '인증 진행 중...';

    try {
        const tokenClient = google.accounts.oauth2.initTokenClient({
            client_id: clientId,
            scope: 'https://www.googleapis.com/auth/youtube.force-ssl',
            callback: (tokenResponse) => {
                if (tokenResponse && tokenResponse.access_token) {
                    oauthAccessToken = tokenResponse.access_token;
                    // Proceed with generation
                    generatePlaylist(songs, geminiKey);
                } else {
                    showError('Google 로그인에 실패했거나 취소되었습니다.');
                }
            },
            error_callback: (err) => {
                showError('Google OAuth 초기화 오류: ' + (err.message || '인증 실패'));
            }
        });
        tokenClient.requestAccessToken();
    } catch (e) {
        showError('Google Identity Services 스크립트 로드에 실패했습니다. (팝업 차단 확인)');
    }
}

// Main Application Flow
async function generatePlaylist(songs, geminiKey) {
    // Hide inputs, show loading
    inputSection.style.display = 'none';
    resultSection.style.display = 'none';
    loadingSection.style.display = 'flex';
    updateLoadingText('AI가 플레이리스트를 구성하는 중...');

    try {
        // Step 2: Call Gemini API (Using gemini-2.5-flash-lite)
        const generatedSongs = await callGeminiAPI(songs, geminiKey);
        
        // Step 3: Parse songs
        const parsedSongs = parseGeneratedSongs(generatedSongs);
        
        if (parsedSongs.length === 0) {
            throw new Error('노래 목록 생성에 실패했습니다. 형식 오류입니다.');
        }

        renderSongs(parsedSongs);
        currentPlaylistText = parsedSongs.map((s, i) => `${i + 1}. ${s}`).join('\n');

        // Step 4: Search Video IDs
        updateLoadingText('유튜브에서 곡들을 검색하는 중...');
        const videoIds = await fetchYoutubeVideos(parsedSongs);
        
        if (videoIds.length === 0) {
            throw new Error('유튜브에서 영상을 하나도 찾지 못했습니다.');
        }

        // Step 5: Create Playlist and add items via YouTube Data API
        updateLoadingText('유튜브 계정에 플레이리스트를 생성하는 중...');
        const playlistId = await createYoutubePlaylist();
        
        updateLoadingText('플레이리스트에 곡을 담는 중...');
        await addVideosToPlaylist(playlistId, videoIds);

        currentYoutubeUrl = `https://www.youtube.com/playlist?list=${playlistId}`;
        document.getElementById('youtube-url').href = currentYoutubeUrl;
        document.getElementById('youtube-url').textContent = currentYoutubeUrl;

        // Show results
        loadingSection.style.display = 'none';
        resultSection.style.display = 'block';

    } catch (error) {
        console.error(error);
        showError(error.message || '처리 중 오류가 발생했습니다.');
    }
}

// Call Gemini API
async function callGeminiAPI(userInput, apiKey) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${apiKey}`;
    const prompt = `다음 노래들을 기반으로 정확히 15곡의 플레이리스트를 만들어라.
사용자가 입력한 곡은 반드시 포함하고 부족하면 비슷한 곡을 추가해라.
플레이리스트 흐름은 자연스럽게 구성한다.
(잔잔한 시작 -> 에너지 상승 -> 자연스러운 마무리)

반환 형식:
1. Artist - Song Title
2. Artist - Song Title
3. Artist - Song Title
...
(15번까지 정확히 포맷을 맞춰서, 다른 인사말이나 부연 설명 없이 번호 목록만 출력해라.)`;

    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            contents: [{
                parts: [{
                    text: `Input Songs:\n${userInput}\n\nTask:\n${prompt}`
                }]
            }]
        })
    });

    if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error?.message || 'Gemini API 호출에 실패했습니다.');
    }

    const data = await response.json();
    return data.candidates[0].content.parts[0].text;
}

// Parse the markdown list into an array of strings
function parseGeneratedSongs(text) {
    const lines = text.split('\n');
    const songPattern = /^\d+\.\s+(.+)/;
    const result = [];

    for (const line of lines) {
        const match = line.trim().match(songPattern);
        if (match && match[1]) {
            // Remove Markdown bold e.g. **Artist - Song**
            let cleanSong = match[1].replace(/\*\*/g, '').trim();
            result.push(cleanSong);
        }
    }
    
    // Return max 15
    return result.slice(0, 15);
}

function renderSongs(songs) {
    const container = document.getElementById('song-list-container');
    container.innerHTML = '';

    songs.forEach((song, i) => {
        const div = document.createElement('div');
        div.className = 'song-item';
        
        const idxSpan = document.createElement('span');
        idxSpan.className = 'song-index';
        idxSpan.textContent = `${i + 1}`;

        const nameSpan = document.createElement('span');
        nameSpan.className = 'song-name';
        nameSpan.textContent = song;

        div.appendChild(idxSpan);
        div.appendChild(nameSpan);
        container.appendChild(div);
    });
}

// Call YouTube Search API to retrieve videoId for each song
async function fetchYoutubeVideos(songs) {
    const videoIds = [];
    
    for (const song of songs) {
        try {
            // Using Authorization Bearer token obtained from GSI
            const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&maxResults=1&q=${encodeURIComponent(song)}&type=video`;
            const response = await fetch(url, {
                headers: { 'Authorization': `Bearer ${oauthAccessToken}` }
            });
            if (response.ok) {
                const data = await response.json();
                if (data.items && data.items.length > 0) {
                    videoIds.push(data.items[0].id.videoId);
                }
            }
        } catch (err) {
            console.error('Failed to search youtube for:', song, err);
        }
    }

    return videoIds;
}

// Create a new Playlist in the user's account
async function createYoutubePlaylist() {
    const url = 'https://www.googleapis.com/youtube/v3/playlists?part=snippet,status';
    const body = {
        snippet: {
            title: 'AI Generated Mix ' + new Date().toLocaleDateString(),
            description: 'Generated by AI Playlist Generator'
        },
        status: {
            privacyStatus: 'private' // default private
        }
    };

    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${oauthAccessToken}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
    });

    if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error?.message || '유튜브 플레이리스트 생성에 실패했습니다.');
    }

    const data = await response.json();
    return data.id; // Returns the new playlistId
}

// Insert videos into the newly created playlist
async function addVideosToPlaylist(playlistId, videoIds) {
    const url = 'https://www.googleapis.com/youtube/v3/playlistItems?part=snippet';
    
    for (const videoId of videoIds) {
        const body = {
            snippet: {
                playlistId: playlistId,
                resourceId: {
                    kind: 'youtube#video',
                    videoId: videoId
                }
            }
        };

        await fetch(url, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${oauthAccessToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(body)
        });
        // Delay is sometimes necessary to avoid Quota issues on massive inserts
    }
}

// Actions
function copyPlaylist() {
    if (!navigator.clipboard) {
        alert("플레이리스트 텍스트:\n\n" + currentPlaylistText);
        return;
    }
    navigator.clipboard.writeText(currentPlaylistText).then(() => {
        alert('플레이리스트가 클립보드에 복사되었습니다.');
    }).catch(err => {
        console.error('Copy failed', err);
    });
}

function openYoutube() {
    if (currentYoutubeUrl) {
        window.open(currentYoutubeUrl, '_blank');
    }
}

function resetApp() {
    document.getElementById('song-input').value = '';
    currentPlaylistText = '';
    currentYoutubeUrl = '';
    oauthAccessToken = null;
    inputSection.style.display = 'block';
    resultSection.style.display = 'none';
    hideError();
}
