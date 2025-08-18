const room = new WebsimSocket();

const myIdElem = document.getElementById('my-id');
const hostIdElem = document.getElementById('host-id');
const hostIndicatorElem = document.getElementById('host-indicator');
const imageUploader = document.getElementById('image-uploader');
const uploadProgress = document.getElementById('upload-progress');
const imageGallery = document.getElementById('image-gallery');
const userList = document.getElementById('user-list');
const hostOfflineMessage = document.getElementById('host-offline-message');
const refreshUsersBtn = document.getElementById('refresh-users-btn');

let isHost = false;
let localImageHalves = JSON.parse(localStorage.getItem('localImageHalves') || '{}');
let creator = null;
const BLOCK_SIZE = 16; // The size of each block for splitting the image

// --- Host/Creator Utilities ---

function getHostInfo() {
    if (!creator) return { clientId: null, username: 'Unknown', isOnline: false };
    
    for (const clientId in room.peers) {
        if (room.peers[clientId].username === creator.username) {
            return { clientId: clientId, username: creator.username, isOnline: true };
        }
    }
    
    return { clientId: null, username: creator.username, isOnline: false };
}

// --- Image Processing Utilities ---

// Simple seeded pseudo-random number generator (LCG)
function createPRNG(seed) {
    let state = seed;
    return function() {
        state = (1103515245 * state + 12345) % 2147483648;
        return state / 2147483648;
    };
}

// Fisher-Yates shuffle using the seeded PRNG
function shuffleArray(array, seed) {
    const random = createPRNG(seed);
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
}

async function splitImage(dataUrl) {
    return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d');
            canvas.width = img.width;
            canvas.height = img.height;
            ctx.drawImage(img, 0, 0);

            const blocks = [];
            const cols = Math.ceil(img.width / BLOCK_SIZE);
            const rows = Math.ceil(img.height / BLOCK_SIZE);

            for (let y = 0; y < rows; y++) {
                for (let x = 0; x < cols; x++) {
                    const blockWidth = (x === cols - 1) ? img.width - x * BLOCK_SIZE : BLOCK_SIZE;
                    const blockHeight = (y === rows - 1) ? img.height - y * BLOCK_SIZE : BLOCK_SIZE;
                    const imageData = ctx.getImageData(x * BLOCK_SIZE, y * BLOCK_SIZE, blockWidth, blockHeight);
                    blocks.push(imageData);
                }
            }

            const seed = Math.floor(Math.random() * 1000000000);
            const indices = Array.from({ length: blocks.length }, (_, i) => i);
            shuffleArray(indices, seed);

            const midPoint = Math.ceil(indices.length / 2);
            const uploaderIndices = indices.slice(0, midPoint);
            const hostIndices = indices.slice(midPoint);
            
            const uploaderBlocks = uploaderIndices.map(i => ({ index: i, data: Array.from(blocks[i].data), width: blocks[i].width, height: blocks[i].height }));
            const hostBlocks = hostIndices.map(i => ({ index: i, data: Array.from(blocks[i].data), width: blocks[i].width, height: blocks[i].height }));

            resolve({
                uploaderPayload: { seed, blocks: uploaderBlocks },
                hostPayload: { blocks: hostBlocks },
                dimensions: { width: img.width, height: img.height }
            });
        };
        img.src = dataUrl;
    });
}

function dataURLtoBlob(dataurl) {
    const arr = dataurl.split(','), mime = arr[0].match(/:(.*?);/)[1];
    const bstr = atob(arr[1]);
    let n = bstr.length;
    const u8arr = new Uint8Array(n);
    while(n--){
        u8arr[n] = bstr.charCodeAt(n);
    }
    return new Blob([u8arr], {type:mime});
}

async function combineHalves(uploaderPayload, hostPayload, dimensions, targetCanvas) {
    if (!uploaderPayload || !hostPayload || !dimensions || !targetCanvas) {
        console.error("Missing data for combining halves.");
        return;
    }
    
    targetCanvas.width = dimensions.width;
    targetCanvas.height = dimensions.height;
    const ctx = targetCanvas.getContext('2d');

    const allBlocks = [...uploaderPayload.blocks, ...hostPayload.blocks].sort((a, b) => a.index - b.index);

    const cols = Math.ceil(dimensions.width / BLOCK_SIZE);

    allBlocks.forEach(({ index, data, width, height }) => {
        const x = (index % cols) * BLOCK_SIZE;
        const y = Math.floor(index / cols) * BLOCK_SIZE;
        const imageData = new ImageData(new Uint8ClampedArray(data), width, height);
        ctx.putImageData(imageData, x, y);
    });
}


// --- UI Rendering ---

function updateHostStatusUI() {
    const hostInfo = getHostInfo();

    hostIdElem.textContent = hostInfo.username;
    isHost = hostInfo.clientId === room.clientId;

    if (hostInfo.isOnline) {
        hostIndicatorElem.textContent = isHost ? '(You are the host)' : '(Online)';
        hostIndicatorElem.className = 'online';
        imageUploader.disabled = false;
        hostOfflineMessage.classList.add('hidden');
    } else {
        hostIndicatorElem.textContent = '(Offline)';
        hostIndicatorElem.className = 'offline';
        imageUploader.disabled = true;
        hostOfflineMessage.classList.remove('hidden');
    }
}

function render() {
    updateHostStatusUI();
    renderUserList();
    renderGallery();
}

function renderUserList() {
    userList.innerHTML = '';
    const hostInfo = getHostInfo();
    for (const clientId in room.peers) {
        const peer = room.peers[clientId];
        const li = document.createElement('li');
        const isMe = clientId === room.clientId;
        const isCurrentHost = peer.username === hostInfo.username;
        
        li.innerHTML = `
            <img src="${peer.avatarUrl}" alt="${peer.username}">
            <span>${peer.username} ${isMe ? '(You)' : ''} ${isCurrentHost ? ' (Host)' : ''}</span>
        `;
        userList.appendChild(li);
    }
}

function renderGallery() {
    imageGallery.innerHTML = '';
    const images = room.roomState.images || {};
    
    Object.keys(images).sort().forEach(imageId => {
        const image = images[imageId];
        const card = document.createElement('div');
        card.className = 'image-card';
        card.id = `card-${imageId}`;

        const isMyImage = image.uploaderId === room.clientId;
        const uploader = room.peers[image.uploaderId]?.username || '...';
        const uploaderIsOnline = !!room.peers[image.uploaderId];

        const hasHostPerm = image.hostVisibility?.[room.clientId];
        const hasUploaderPerm = image.uploaderVisibility?.[room.clientId];
        const canISee = hasHostPerm && hasUploaderPerm;

        let statusText = '';
        if (isMyImage) {
            statusText = `You are the uploader.
                <br>
                ${hasHostPerm ? '✅ Host granted you access' : '❌ Host permission needed'}
            `;
        } else if (isHost) {
            statusText = `You are the host.
                <br>
                ${hasUploaderPerm ? '✅ Uploader granted you access' : '❌ Uploader permission needed'}
            `;
        } else {
            statusText = `
                ${hasUploaderPerm ? '✅ Uploader granted access' : '❌ Uploader permission needed'}
                <br>
                ${hasHostPerm ? '✅ Host granted access' : '❌ Host permission needed'}
            `;
        }

        card.innerHTML = `
            <div class="image-placeholder">
                <canvas id="canvas-${imageId}"></canvas>
                ${!canISee ? `<div class="locked-overlay">🔒</div>` : ''}
            </div>
            <div class="image-controls">
                <p>Uploaded by: ${isMyImage ? 'You' : uploader} ${!uploaderIsOnline ? '(Offline)' : ''}</p>
                <p>Status: ${statusText}</p>
                <div class="permissions" id="perms-${imageId}"></div>
            </div>
        `;
        imageGallery.appendChild(card);
        
        if (canISee) {
            loadImage(imageId, image);
        }

        renderPermissions(imageId, image, isMyImage);
    });
}

async function loadImage(imageId, image) {
    const canvas = document.getElementById(`canvas-${imageId}`);
    if (!canvas) return;

    try {
        // Uploader's half is always from local storage
        const uploaderPayload = localImageHalves[imageId];
        
        // Host's half is fetched from the URL
        const response = await fetch(image.hostHalfUrl);
        const hostPayload = await response.json();
        
        if (uploaderPayload && hostPayload) {
            await combineHalves(uploaderPayload, hostPayload, image.dimensions, canvas);
        } else {
            console.error(`Missing payload half for image ${imageId}`);
        }
    } catch (error) {
        console.error("Error combining image halves:", error);
    }
}

function renderPermissions(imageId, image, isMyImage) {
    const permsContainer = document.getElementById(`perms-${imageId}`);
    if (!permsContainer) return;
    permsContainer.innerHTML = '';

    // Host permissions (only host can see and change)
    if (isHost) {
        const hostPerms = document.createElement('div');
        hostPerms.innerHTML = `<h4>Host Visibility</h4>`;
        for (const clientId in room.peers) {
            const peer = room.peers[clientId];
            const isChecked = image.hostVisibility?.[clientId] || false;
            hostPerms.innerHTML += `
                <label>
                    <input type="checkbox" data-type="host" data-image-id="${imageId}" data-client-id="${clientId}" ${isChecked ? 'checked' : ''}>
                    ${peer.username}
                </label>
            `;
        }
        permsContainer.appendChild(hostPerms);
    }
    
    // Uploader permissions (only uploader can see and change)
    if (isMyImage) {
        const uploaderPerms = document.createElement('div');
        uploaderPerms.innerHTML = `<h4>Your Visibility</h4>`;
        for (const clientId in room.peers) {
            const peer = room.peers[clientId];
            const isChecked = image.uploaderVisibility?.[clientId] || false;
            uploaderPerms.innerHTML += `
                <label>
                    <input type="checkbox" data-type="uploader" data-image-id="${imageId}" data-client-id="${clientId}" ${isChecked ? 'checked' : ''}>
                    ${peer.username}
                </label>
            `;
        }
        permsContainer.appendChild(uploaderPerms);
    }
}

// --- Event Handlers ---

async function handleImageUpload(event) {
    const file = event.target.files[0];
    if (!file) return;

    uploadProgress.classList.remove('hidden');

    const hostInfo = getHostInfo();
    if (!hostInfo.isOnline || !hostInfo.clientId) {
        alert("Host is offline. Cannot upload image.");
        uploadProgress.classList.add('hidden');
        imageUploader.value = '';
        return;
    }

    const reader = new FileReader();
    reader.onload = async (e) => {
        try {
            const { uploaderPayload, hostPayload, dimensions } = await splitImage(e.target.result);
            
            // Upload host's half
            const hostHalfBlob = new Blob([JSON.stringify(hostPayload)], { type: 'application/json' });
            const hostHalfUrl = await websim.upload(hostHalfBlob);

            const imageId = `img_${Date.now()}_${room.clientId}`;
            
            // Store uploader's half locally
            localImageHalves[imageId] = uploaderPayload;
            localStorage.setItem('localImageHalves', JSON.stringify(localImageHalves));

            // Grant mutual permission to uploader and host by default
            const uploaderVisibility = {
                [room.clientId]: true, // Uploader grants self
                [hostInfo.clientId]: true // Uploader grants host
            };
            const hostVisibility = {
                [room.clientId]: true, // Host grants uploader
                [hostInfo.clientId]: true // Host grants self
            };

            room.updateRoomState({
                images: {
                    [imageId]: {
                        uploaderId: room.clientId,
                        hostHalfUrl: hostHalfUrl,
                        dimensions: dimensions,
                        uploaderVisibility,
                        hostVisibility,
                    }
                }
            });
        } catch (error) {
            console.error("Upload failed:", error);
            alert("Upload failed. Please try again.");
        } finally {
            uploadProgress.classList.add('hidden');
            imageUploader.value = ''; // Reset input
        }
    };
    reader.readAsDataURL(file);
}

function handlePermissionChange(event) {
    const target = event.target;
    if (target.type !== 'checkbox') return;

    const { type, imageId, clientId } = target.dataset;
    const isChecked = target.checked;

    const key = type === 'host' ? 'hostVisibility' : 'uploaderVisibility';

    room.updateRoomState({
        images: {
            [imageId]: {
                [key]: {
                    [clientId]: isChecked
                }
            }
        }
    });
}


// --- Main Application Logic ---

async function main() {
    creator = await window.websim.getCreator();
    await room.initialize();

    myIdElem.textContent = room.clientId;

    room.subscribePresence(() => {
        render();
    });

    room.subscribeRoomState(() => {
        render();
    });
    
    render();

    imageUploader.addEventListener('change', handleImageUpload);
    document.body.addEventListener('change', handlePermissionChange);
    refreshUsersBtn.addEventListener('click', render);
    
    // Auto-refresh every 7 seconds
    setInterval(render, 7000);
}

main();