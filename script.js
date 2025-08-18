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

function splitImage(dataUrl) {
    return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d');
            canvas.width = img.width;
            canvas.height = img.height;
            ctx.drawImage(img, 0, 0);

            const halfWidth = Math.ceil(img.width / 2);
            
            // Left Half
            const leftCanvas = document.createElement('canvas');
            leftCanvas.width = halfWidth;
            leftCanvas.height = img.height;
            const leftCtx = leftCanvas.getContext('2d');
            leftCtx.drawImage(canvas, 0, 0, halfWidth, img.height, 0, 0, halfWidth, img.height);
            const leftHalfDataUrl = leftCanvas.toDataURL('image/png');

            // Right Half
            const rightCanvas = document.createElement('canvas');
            rightCanvas.width = img.width - halfWidth;
            rightCanvas.height = img.height;
            const rightCtx = rightCanvas.getContext('2d');
            rightCtx.drawImage(canvas, halfWidth, 0, img.width - halfWidth, img.height, 0, 0, img.width - halfWidth, img.height);
            const rightHalfDataUrl = rightCanvas.toDataURL('image/png');
            
            resolve({ localHalf: leftHalfDataUrl, serverHalf: rightHalfDataUrl });
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

async function combineHalves(half1Url, half2Url, targetCanvas) {
    const [img1, img2] = await Promise.all([
      new Promise(resolve => { const i = new Image(); i.onload=()=>resolve(i); i.src=half1Url; }),
      new Promise(resolve => { const i = new Image(); i.onload=()=>resolve(i); i.src=half2Url; }),
    ]);

    const ctx = targetCanvas.getContext('2d');
    targetCanvas.width = img1.width + img2.width;
    targetCanvas.height = Math.max(img1.height, img2.height);

    ctx.drawImage(img1, 0, 0);
    ctx.drawImage(img2, img1.width, 0);
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

        const canISee = (image.hostVisibility?.[room.clientId] && image.uploaderVisibility?.[room.clientId]) || isMyImage;

        card.innerHTML = `
            <div class="image-placeholder">
                <canvas id="canvas-${imageId}"></canvas>
                ${!canISee ? `<div class="locked-overlay">🔒</div>` : ''}
            </div>
            <div class="image-controls">
                <p>Uploaded by: ${isMyImage ? 'You' : uploader}</p>
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
        const localHalf = localImageHalves[imageId];
        const serverHalfUrl = image.serverHalfUrl;
        
        if (localHalf && serverHalfUrl) {
            await combineHalves(localHalf, serverHalfUrl, canvas);
        } else {
            console.error(`Missing half for image ${imageId}`);
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
    const reader = new FileReader();
    reader.onload = async (e) => {
        try {
            const { localHalf, serverHalf } = await splitImage(e.target.result);
            const serverHalfBlob = dataURLtoBlob(serverHalf);

            const serverHalfUrl = await websim.upload(serverHalfBlob);

            const imageId = `img_${Date.now()}_${room.clientId}`;
            
            // Store local half
            localImageHalves[imageId] = localHalf;
            localStorage.setItem('localImageHalves', JSON.stringify(localImageHalves));

            // Update room state
            const uploaderVisibility = { [room.clientId]: true };
            const hostVisibility = { [room.clientId]: true };

            room.updateRoomState({
                images: {
                    [imageId]: {
                        uploaderId: room.clientId,
                        serverHalfUrl: serverHalfUrl,
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
    
    // Auto-refresh every 7 seconds
    setInterval(render, 7000);
    
    // The refresh button is no longer needed with auto-refresh
    refreshUsersBtn.style.display = 'none';
}

main();