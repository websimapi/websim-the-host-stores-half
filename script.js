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
const hostControls = document.getElementById('host-controls');
const contentCheckToggle = document.getElementById('content-check-toggle');

let isHost = false;
let localImageHalves = JSON.parse(localStorage.getItem('localImageHalves') || '{}');
let receivedImageHalves = {}; // In-memory cache for halves received from other users
let creator = null;
const BLOCK_SIZE = 16; // The size of each block for splitting the image

// --- Host/Creator Utilities ---

async function getCreatorUsername() {
    if (!creator) {
        creator = await window.websim.getCreatedBy();
    }
    return creator.username;
}

async function getHostInfo() {
    const creatorUsername = await getCreatorUsername();
    if (!creatorUsername) return { clientId: null, username: 'Unknown', isOnline: false };
    
    for (const clientId in room.peers) {
        if (room.peers[clientId].username === creatorUsername) {
            return { clientId: clientId, username: creatorUsername, isOnline: true };
        }
    }
    
    return { clientId: null, username: creatorUsername, isOnline: false };
}

// --- Image Processing & Security Utilities ---

// Simple SHA-256 hashing for file verification
async function hashFile(file) {
    const buffer = await file.arrayBuffer();
    const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

// Mock content check function. In a real application, this would call a server-side API.
async function checkImageContent(imageUrl) {
    console.log(`Checking image content for: ${imageUrl}`);
    // Simulate network delay and analysis
    await new Promise(resolve => setTimeout(resolve, 1500));
    
    // In a real scenario, you'd fetch the image, send it to a service like AWS Rekognition or a custom model.
    // For this demo, we'll use a placeholder check.
    // Let's flag any image that has "flagged" in its filename for demonstration.
    if (imageUrl.toLowerCase().includes('flagged')) {
        console.warn("Content check FAILED for:", imageUrl);
        return { safe: false, reason: "Content Flagged" };
    }
    
    console.log("Content check PASSED for:", imageUrl);
    return { safe: true };
}

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

async function splitImage(imageUrl) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
            let canvas = document.createElement('canvas');
            let ctx = canvas.getContext('2d');
            canvas.width = img.width;
            canvas.height = img.height;
            ctx.drawImage(img, 0, 0);

            let blocks = [];
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
            
            // Explicitly clear the full image from the canvas now that we have the blocks
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            canvas.width = 0;
            canvas.height = 0;
            canvas = null;
            ctx = null;

            const seed = Math.floor(Math.random() * 1000000000);
            const indices = Array.from({ length: blocks.length }, (_, i) => i);
            shuffleArray(indices, seed);

            const midPoint = Math.ceil(indices.length / 2);
            const uploaderIndices = indices.slice(0, midPoint);
            const hostIndices = indices.slice(midPoint);
            
            const uploaderBlocks = uploaderIndices.map(i => ({ index: i, data: Array.from(blocks[i].data), width: blocks[i].width, height: blocks[i].height }));
            const hostBlocks = hostIndices.map(i => ({ index: i, data: Array.from(blocks[i].data), width: blocks[i].width, height: blocks[i].height }));
            
            blocks = null; // Release the array holding all blocks

            resolve({
                uploaderPayload: { seed, blocks: uploaderBlocks },
                hostPayload: { blocks: hostBlocks },
                dimensions: { width: img.width, height: img.height }
            });
        };
        img.onerror = (err) => {
            reject(new Error("Failed to load image for splitting."));
        };
        img.src = imageUrl;
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

async function updateHostStatusUI() {
    const hostInfo = await getHostInfo();

    hostIdElem.textContent = hostInfo.username;
    isHost = hostInfo.clientId === room.clientId;

    if (isHost) {
        hostControls.classList.remove('hidden');
    }

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

async function render() {
    try {
        await updateHostStatusUI();
        updateContentCheckToggle();
        await renderUserList();
        renderGallery();

        if (isHost) {
            await processPendingImages();
        }
    } catch (error) {
        console.error("Error during render:", error);
    }
}

function updateContentCheckToggle() {
    const contentCheckEnabled = room.roomState.contentCheckEnabled || false;
    if (contentCheckToggle.checked !== contentCheckEnabled) {
        contentCheckToggle.checked = contentCheckEnabled;
    }
}

async function renderUserList() {
    userList.innerHTML = '';
    const hostInfo = await getHostInfo();
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
    const images = room.roomState.images || {};
    const renderedImageIds = new Set();
    
    Object.keys(images).sort().forEach(imageId => {
        renderedImageIds.add(imageId);
        const image = images[imageId];
        let card = document.getElementById(`card-${imageId}`);
        let canvas = document.getElementById(`canvas-${imageId}`);

        // If card doesn't exist, create it.
        if (!card) {
            card = document.createElement('div');
            card.className = 'image-card';
            card.id = `card-${imageId}`;
            card.innerHTML = `
                <div class="image-placeholder">
                    <canvas id="canvas-${imageId}"></canvas>
                    <div class="locked-overlay" style="display: flex;">🔒</div>
                    <div class="pending-overlay" style="display: none;"></div>
                </div>
                <div class="image-controls">
                    <p class="uploader-info"></p>
                    <p class="status-info"></p>
                    <div class="image-info" id="info-${imageId}"></div>
                    <div class="permissions" id="perms-${imageId}"></div>
                </div>
            `;
            imageGallery.appendChild(card);
            canvas = document.getElementById(`canvas-${imageId}`); // Get the new canvas element
        }

        const isMyImage = image.uploaderId === room.clientId;
        const uploader = room.peers[image.uploaderId]?.username || '...';
        const uploaderIsOnline = !!room.peers[image.uploaderId];
        card.querySelector('.uploader-info').innerHTML = `Uploaded by: ${isMyImage ? 'You' : uploader} ${!uploaderIsOnline ? '(Offline)' : ''}`;

        const lockOverlay = card.querySelector('.locked-overlay');
        const pendingOverlay = card.querySelector('.pending-overlay');
        const imageControls = card.querySelector('.image-controls');

        if (image.status === 'pending_check') {
            lockOverlay.style.display = 'none';
            pendingOverlay.style.display = 'flex';
            pendingOverlay.textContent = 'Pending host verification...';
            imageControls.style.display = 'none';
            continue; // Skip the rest of the rendering for this pending image
        } else {
            pendingOverlay.style.display = 'none';
            imageControls.style.display = 'block';
        }

        const hasHostPerm = image.hostVisibility?.[room.clientId];
        const hasUploaderPerm = image.uploaderVisibility?.[room.clientId];
        const canISee = (isMyImage || hasUploaderPerm) && (isHost || hasHostPerm);

        // Update dynamic content
        card.querySelector('.status-info').innerHTML = `Status: ${canISee ? '✅ Access granted' : '❌ Access denied'}`;
        
        lockOverlay.style.display = canISee ? 'none' : 'flex';

        // --- FLASHING FIX ---
        // Only load image if we have permission AND it hasn't been rendered yet.
        if (canISee && !canvas.dataset.rendered) {
            loadImage(imageId, image);
            canvas.dataset.rendered = 'true';
        } 
        // If we lose permission, clear the canvas and reset the rendered flag.
        else if (!canISee && canvas.dataset.rendered === 'true') {
            const ctx = canvas.getContext('2d');
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            canvas.dataset.rendered = 'false';
        }

        // These can change, so they are always re-rendered.
        renderImageInfo(imageId, image, isMyImage);
        renderPermissions(imageId, image, isMyImage);
    });

    // Remove cards for images that no longer exist in the room state
    for (const card of Array.from(imageGallery.children)) {
        const imageId = card.id.replace('card-', '');
        if (!renderedImageIds.has(imageId)) {
            card.remove();
        }
    }
}

async function loadImage(imageId, image) {
    const canvas = document.getElementById(`canvas-${imageId}`);
    if (!canvas) return;

    try {
        let uploaderPayload = null;

        if (image.uploaderId === room.clientId) {
            // I am the uploader, I have the half locally.
            uploaderPayload = localImageHalves[imageId];
        } else {
            // I am not the uploader, check if I've received the half.
            uploaderPayload = receivedImageHalves[imageId];
            if (!uploaderPayload) {
                // If not, and uploader is online, request it.
                if (room.peers[image.uploaderId]) {
                    console.log(`Requesting uploader half for ${imageId} from ${image.uploaderId}`);
                    room.requestPresenceUpdate(image.uploaderId, {
                        type: 'requestImageHalf',
                        imageId: imageId,
                    });
                }
                return; // Wait for the half to be received.
            }
        }
        
        // Host's half is fetched from the URL
        const response = await fetch(image.hostHalfUrl);
        if (!response.ok) throw new Error(`Failed to fetch host half: ${response.statusText}`);
        const hostPayload = await response.json();
        
        if (uploaderPayload && hostPayload) {
            await combineHalves(uploaderPayload, hostPayload, image.dimensions, canvas);
        } else {
            console.error(`Missing a payload half for image ${imageId}`);
        }
    } catch (error) {
        console.error(`Error loading image ${imageId}:`, error);
    }
}

function renderImageInfo(imageId, image, isMyImage) {
    const infoContainer = document.getElementById(`info-${imageId}`);
    if (!infoContainer) return;

    let totalBlocks = 0;
    // Calculate total blocks from dimensions.
    if(image.dimensions) {
        const cols = Math.ceil(image.dimensions.width / BLOCK_SIZE);
        const rows = Math.ceil(image.dimensions.height / BLOCK_SIZE);
        totalBlocks = cols * rows;
    }
    
    let myBlocks = 0;
    if (isMyImage) {
        myBlocks = localImageHalves[imageId]?.blocks.length || 0;
    } else if (isHost) {
        // As host, we don't store blocks, but we know our half exists at the URL.
        // A more complex implementation could fetch and count, but this is a good approximation.
        myBlocks = Math.floor(totalBlocks / 2);
    }

    infoContainer.innerHTML = `You hold ${myBlocks} of ${totalBlocks} blocks.`;
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
            // Don't show checkbox for the host to grant permission to themself.
            if (clientId === room.clientId) continue;

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
            // Don't show checkbox for the uploader to grant permission to themself.
            if (clientId === room.clientId) continue;
            
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

    const hostInfo = await getHostInfo();
    if (!hostInfo.isOnline || !hostInfo.clientId) {
        alert("Host is offline. Cannot upload image.");
        uploadProgress.classList.add('hidden');
        imageUploader.value = '';
        return;
    }

    const contentCheckEnabled = room.roomState.contentCheckEnabled || false;

    try {
        if (contentCheckEnabled) {
            await handleSecureUpload(file, hostInfo);
        } else {
            await handleStandardUpload(file, hostInfo);
        }
    } catch (error) {
        console.error("Upload failed:", error);
        alert(`Upload failed: ${error.message}`);
    } finally {
        uploadProgress.classList.add('hidden');
        imageUploader.value = ''; // Reset input
    }
}

async function handleStandardUpload(file, hostInfo) {
    const objectURL = URL.createObjectURL(file);
    try {
        const { uploaderPayload, hostPayload, dimensions } = await splitImage(objectURL);
        const hostHalfBlob = new Blob([JSON.stringify(hostPayload)], { type: 'application/json' });
        const hostHalfUrl = await websim.upload(hostHalfBlob);
        const imageId = `img_${Date.now()}_${room.clientId}`;

        localImageHalves[imageId] = uploaderPayload;
        localStorage.setItem('localImageHalves', JSON.stringify(localImageHalves));

        const uploaderVisibility = { [room.clientId]: true, [hostInfo.clientId]: true };
        const hostVisibility = { [room.clientId]: true, [hostInfo.clientId]: true };

        room.updateRoomState({
            images: {
                [imageId]: {
                    status: 'approved',
                    uploaderId: room.clientId,
                    hostHalfUrl,
                    dimensions,
                    uploaderVisibility,
                    hostVisibility,
                }
            }
        });
    } finally {
        URL.revokeObjectURL(objectURL);
    }
}

async function handleSecureUpload(file, hostInfo) {
    // 1. Upload full image to get a temporary URL
    const fullImageUrl = await websim.upload(file);
    const imageHash = await hashFile(file);
    const imageId = `img_${Date.now()}_${room.clientId}`;

    // 2. Create a pending record in roomState
    await room.updateRoomState({
        images: {
            [imageId]: {
                status: 'pending_check',
                uploaderId: room.clientId,
                fullImageUrl,
                imageHash,
            }
        }
    });

    // 3. Wait for host to approve/reject
    const unsubscribe = room.collection('roomState').subscribe(async (newRoomState) => {
        const imageState = newRoomState?.images?.[imageId];
        if (imageState && imageState.status !== 'pending_check') {
            unsubscribe(); // Stop listening
            if (imageState.status === 'approved') {
                console.log(`Image ${imageId} approved by host. Finalizing upload.`);
                // 4. If approved, proceed with splitting and finalizing
                const objectURL = URL.createObjectURL(file);
                try {
                    const { uploaderPayload, hostPayload, dimensions } = await splitImage(objectURL);
                    const hostHalfBlob = new Blob([JSON.stringify(hostPayload)], { type: 'application/json' });
                    const hostHalfUrl = await websim.upload(hostHalfBlob);
                    
                    localImageHalves[imageId] = uploaderPayload;
                    localStorage.setItem('localImageHalves', JSON.stringify(localImageHalves));

                    const uploaderVisibility = { [room.clientId]: true, [hostInfo.clientId]: true };
                    const hostVisibility = { [room.clientId]: true, [hostInfo.clientId]: true };
                    
                    await room.updateRoomState({
                        images: {
                            [imageId]: {
                                // Overwrite the pending record with the final data
                                status: 'approved',
                                uploaderId: room.clientId,
                                hostHalfUrl,
                                dimensions,
                                uploaderVisibility,
                                hostVisibility,
                                fullImageUrl: null, // Clear temp data
                                imageHash: null,
                            }
                        }
                    });
                } finally {
                    URL.revokeObjectURL(objectURL);
                }
            } else if (imageState.status === 'rejected') {
                alert(`Your image upload was rejected by the host. Reason: ${imageState.rejectionReason}`);
                // 5. If rejected, remove the record
                await room.updateRoomState({ images: { [imageId]: null } });
            }
        }
    });
}

async function processPendingImages() {
    const images = room.roomState.images || {};
    for (const imageId in images) {
        const image = images[imageId];
        if (image.status === 'pending_check') {
            console.log(`Host processing pending image: ${imageId}`);
            // Mark as processing to avoid multiple checks
            await room.updateRoomState({ images: { [imageId]: { status: 'processing' } } });

            try {
                // Fetch and verify hash
                const response = await fetch(image.fullImageUrl);
                const blob = await response.blob();
                const file = new File([blob], "image");
                const calculatedHash = await hashFile(file);

                if (calculatedHash !== image.imageHash) {
                    throw new Error("Image hash mismatch. Potential tampering.");
                }

                // Check content
                const checkResult = await checkImageContent(image.fullImageUrl);
                if (checkResult.safe) {
                    await room.updateRoomState({ images: { [imageId]: { status: 'approved' } } });
                } else {
                    await room.updateRoomState({ images: { [imageId]: { status: 'rejected', rejectionReason: checkResult.reason } } });
                }
            } catch (error) {
                console.error(`Error processing image ${imageId}:`, error);
                await room.updateRoomState({ images: { [imageId]: { status: 'rejected', rejectionReason: error.message } } });
            }
        }
    }
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

function handleContentCheckToggle() {
    room.updateRoomState({
        contentCheckEnabled: contentCheckToggle.checked
    });
}

// --- Main Application Logic ---

async function main() {
    creator = await window.websim.getCreatedBy();
    await room.initialize();

    myIdElem.textContent = room.clientId;

    room.subscribePresence(() => {
        render();
    });

    room.subscribeRoomState(() => {
        render();
    });

    room.subscribePresenceUpdateRequests((updateRequest, fromClientId) => {
        if (updateRequest.type === 'requestImageHalf') {
            const { imageId } = updateRequest;
            const image = room.roomState.images?.[imageId];
            const uploaderHalf = localImageHalves[imageId];

            // I must be the uploader, have the half, and have granted permission
            if (image && image.uploaderId === room.clientId && uploaderHalf && image.uploaderVisibility?.[fromClientId]) {
                console.log(`Sending half for ${imageId} to ${fromClientId}`);
                room.send({
                    type: 'imageHalfData',
                    recipientId: fromClientId,
                    imageId: imageId,
                    payload: uploaderHalf
                });
            }
        }
    });

    room.onmessage = (event) => {
        const data = event.data;
        if (data.type === 'imageHalfData' && data.recipientId === room.clientId) {
            console.log(`Received half for ${data.imageId}`);
            receivedImageHalves[data.imageId] = data.payload;
            // Re-render the specific image now that we have the data
            const image = room.roomState.images?.[data.imageId];
            if (image) {
                loadImage(data.imageId, image);
            }
        }
    };
    
    render();

    imageUploader.addEventListener('change', handleImageUpload);
    document.body.addEventListener('change', handlePermissionChange);
    contentCheckToggle.addEventListener('change', handleContentCheckToggle);
    refreshUsersBtn.addEventListener('click', render);
    
    // Auto-refresh every 7 seconds
    setInterval(render, 7000);
}

main();