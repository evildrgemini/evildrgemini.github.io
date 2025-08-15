// Import prompts from the separate file (if still needed for single-player)
import { geemsPrompts, multiplayerDatePrompt } from './prompts.js';
import MPLib from './mp.js';

// --- Game State Variables ---
let historyQueue = [];
const MAX_HISTORY_SIZE = 20;
let currentUiJson = null;
let currentNotes = {};
let currentSubjectId = "";
let isMasturbationMode = false; // Default mode
let isLoading = false;
let apiKeyLocked = false;
let localGameStateSnapshot = null; // To store local state when viewing remote state
let hiddenAnalysisContent = null; // To store content of gemini_facing_analysis for modal
let hiddenAnalysisContentTweet = null; // To store content of gemini_facing_analysis for modal
let hiddenAnalysisContentNotes = null; // To store content of gemini_facing_analysis for modal
let debugMode = false; // New state for debug mode
let currentlyViewingPeerId = null; // To track if we are viewing another player's state
let matchmakingQueue = [];
let multiplayerDateState = null;

// --- Model Switching State ---
const AVAILABLE_MODELS = [
    "gemini-1.5-pro",
    "gemini-2.5-flash-preview-05-20",
];

let currentModelIndex = 0;

// --- Configuration ---
const MIN_CONTRAST_LIGHTNESS = 0.55;
const LOCAL_STORAGE_KEY = 'geemsGameStateToRestore';
const DEFAULT_HOST_ID = 'geems-default-game-host';

// --- Helper Functions ---
function constructPrompt(playerActionsJson, historyQueue, isMasturbationMode) {
    const baseMainPrompt = geemsPrompts.main;
    const activeAddendum = isMasturbationMode ? `\n\n---\n${geemsPrompts.masturbationModeAddendum}\n---\n` : "";
    if (historyQueue.length === 0) {
        const s = `${geemsPrompts.firstrun}\n\n---\n${baseMainPrompt}${activeAddendum}\n---\n${geemsPrompts.exampleTurn}\n---\n\n--- Generate JSON UI for Turn 1 ---`;
        return s;
    } else {
        const historyString = historyQueue.map(item => `UI:\n${item.ui}\nActions:\n${item.actions}`).join('\n---\n');
        const s = `${baseMainPrompt}${activeAddendum}\n\n--- Last Player Actions ---\n${playerActionsJson}\n\n--- Prior Game History (Last ${historyQueue.length} turns) ---\n${historyString}\n\n--- Generate Next Game Turn JSON UI ARRAY ---`;
        return s;
    }
}

async function callRealGeminiAPI(apiKey, promptText, modelName) {
    const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;
    const requestBody = {
        contents: [{parts: [{text: promptText}]}],
        generationConfig: {temperature: 1.0, response_mime_type: "application/json"},
        safetySettings: [{"category": "HARM_CATEGORY_HARASSMENT", "threshold": "BLOCK_NONE"}, {"category": "HARM_CATEGORY_HATE_SPEECH", "threshold": "BLOCK_NONE"}, {"category": "HARM_CATEGORY_SEXUALLY_EXPLICIT", "threshold": "BLOCK_NONE"}, {"category": "HARM_CATEGORY_DANGEROUS_CONTENT", "threshold": "BLOCK_NONE"}]
    };
    const response = await fetch(API_URL, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(requestBody)
    });
    if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`API request failed (${response.status}): ${errorBody}`);
    }
    const responseData = await response.json();
    if (responseData.promptFeedback && responseData.promptFeedback.blockReason) {
        throw new Error(`Request blocked by API. Reason: ${responseData.promptFeedback.blockReason}.`);
    }
    if (!responseData.candidates || responseData.candidates.length === 0) {
        throw new Error('No candidates or unexpected API response.');
    }
    const candidate = responseData.candidates[0];
    if (candidate.content && candidate.content.parts && candidate.content.parts.length > 0) {
        let generatedText = candidate.content.parts[0].text;
        const jsonMatch = generatedText.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
        return jsonMatch ? jsonMatch[1].trim() : generatedText.trim();
    } else {
        throw new Error('API candidate generated but no content parts.');
    }
}

function showNotification(message, type = 'info', duration = 4000) {
    console.log(`[Notification-${type}] ${message}`);
    // A more user-facing notification system can be built here.
}

function showError(message) {
    console.error("ERROR:", message);
    alert("Error: " + message);
}

function renderHistory() {
    const historyContainer = document.getElementById('history-container');
    historyContainer.innerHTML = ''; // Clear it out

    if (historyQueue.length === 0) {
        historyContainer.innerHTML = '<p class="text-gray-400">No session history yet. Go on a date first.</p>';
        return;
    }

    // If viewing another player, we can see the analysis. If viewing self, depends on debugMode.
    const canViewAnalysis = debugMode || currentlyViewingPeerId !== null;

    historyQueue.forEach((turn, index) => {
        const turnDiv = document.createElement('div');
        turnDiv.className = 'bg-gray-700 p-4 rounded-lg';

        const turnHeader = document.createElement('h3');
        turnHeader.className = 'text-xl font-bold text-purple-300';
        turnHeader.textContent = `Turn ${index + 1}`;
        turnDiv.appendChild(turnHeader);

        if (canViewAnalysis && turn.analysis) {
            const analysisPre = document.createElement('pre');
            analysisPre.className = 'text-sm text-gray-300 whitespace-pre-wrap font-mono mt-2 p-2 bg-black bg-opacity-20 rounded';
            analysisPre.textContent = turn.analysis;
            turnDiv.appendChild(analysisPre);
        } else {
            const noAnalysisP = document.createElement('p');
            noAnalysisP.className = 'text-sm text-gray-400 italic mt-2';
            noAnalysisP.textContent = 'Clinical analysis for this turn is redacted.';
            turnDiv.appendChild(noAnalysisP);
        }
        historyContainer.appendChild(turnDiv);
    });
}


// --- Solo Date Logic ---
function processSuccessfulResponse(responseJson, playerActionsJson) {
    currentUiJson = responseJson;
    // This needs to be replaced with the actual solo date render logic
    console.log("Rendering solo date UI (placeholder)...");

    if (historyQueue.length > 0) {
        historyQueue[historyQueue.length - 1].analysis = hiddenAnalysisContent;
    }
    // ...
}


// --- Multiplayer Date Logic ---
function findMultiplayerDate() {
    showNotification("Looking for a partner...", "info");
    const localId = MPLib.getLocalPeerId();
    if (!localId) {
        showError("Not connected to the network.");
        return;
    }
    if (!matchmakingQueue.includes(localId)) {
        matchmakingQueue.push(localId);
    }
    if (matchmakingQueue.length >= 2) {
        const partnerId = matchmakingQueue.find(id => id !== localId);
        if (partnerId) {
            matchmakingQueue = matchmakingQueue.filter(id => id !== localId && id !== partnerId);
            MPLib.sendDirect(partnerId, { type: 'date_request', from: localId });
            showNotification(`Sent a date request to ${partnerId.slice(-6)}.`, "info");
        }
    }
}

async function startMultiplayerDate(partnerId, isHost) {
    const localId = MPLib.getLocalPeerId();
    multiplayerDateState = {
        players: isHost ? [localId, partnerId] : [partnerId, localId],
        host: isHost ? localId : partnerId,
        turn: 0,
        history: [],
        currentTurnActions: {}
    };

    document.getElementById('lobby').style.display = 'none';
    document.getElementById('multiplayer-date').style.display = 'block';
    showNotification(`Date started with ${partnerId.slice(-6)}!`, "success");

    if (isHost) {
        showNotification("You are the host. Generating opening scene...", "info");
        const playerAProfile = "A new subject, probably full of predictable anxieties.";
        const playerBProfile = "Another new subject, let's see if they are any more interesting.";

        const openingPrompt = multiplayerDatePrompt
            .replace('Subject A Profile:', `Subject A Profile: ${playerAProfile}`)
            .replace('Subject B Profile:', `Subject B Profile: ${playerBProfile}`)
            .replace('Date History:', 'Date History: None. This is the first turn.')
            .replace('Subject A Action:', 'Subject A Action: They have just agreed to this date.')
            .replace('Subject B Action:', 'Subject B Action: They have also just agreed.');

        try {
            const apiKey = document.getElementById('apiKeyInput').value.trim();
            if (!apiKey) {
                showError("API Key required to start a date.");
                return;
            }
            const newTurnUI = await callRealGeminiAPI(apiKey, openingPrompt, AVAILABLE_MODELS[0]);
            const newTurnJson = JSON.parse(newTurnUI);

            const updatePayload = { type: 'date_ui_update', ui: newTurnJson, turn: 1 };
            multiplayerDateState.players.forEach(pId => {
                if (pId !== localId) MPLib.sendDirect(pId, updatePayload);
            });
            handleDateUiUpdate(newTurnJson, 1);

        } catch (error) {
            console.error("Error generating opening date scene:", error);
            showError("Failed to start the date.");
        }
    }
}

function submitMultiplayerAction() {
    if (!multiplayerDateState) return;

    const localId = MPLib.getLocalPeerId();
    const playerIndex = multiplayerDateState.players.indexOf(localId);
    const playerLetter = playerIndex === 0 ? 'a' : 'b';
    const actionInput = document.querySelector(`input[name="player_${playerLetter}_action"]:checked`);

    if (actionInput) {
        const action = actionInput.value;
        showNotification("Action submitted. Waiting for partner...", "info");

        if (multiplayerDateState.host === localId) {
            handleDateAction(localId, action);
        } else {
            MPLib.sendDirect(multiplayerDateState.host, { type: 'date_action', payload: { action: action } });
        }
        document.getElementById('multiplayer-input-area').innerHTML = '<div class="text-center text-gray-400">Waiting for partner...</div>';
    } else {
        showError("Please select an action.");
    }
}

function renderMultiplayerUI(ui) {
    const gameplayArea = document.getElementById('multiplayer-gameplay-area');
    const inputArea = document.getElementById('multiplayer-input-area');
    gameplayArea.innerHTML = '';
    inputArea.innerHTML = '';

    const narrative = ui.find(el => el.name === 'narrative')?.value || "The Date Master is silent.";
    const narrativeP = document.createElement('p');
    narrativeP.textContent = narrative;
    gameplayArea.appendChild(narrativeP);

    const localId = MPLib.getLocalPeerId();
    const playerIndex = multiplayerDateState.players.indexOf(localId);
    const playerLetter = playerIndex === 0 ? 'a' : 'b';

    const playerPrompt = ui.find(el => el.name === `player_${playerLetter}_prompt`)?.value;
    if (playerPrompt) {
        const promptP = document.createElement('p');
        promptP.className = 'mt-4 font-bold';
        promptP.textContent = playerPrompt;
        inputArea.appendChild(promptP);
    }

    const playerChoicesValue = ui.find(el => el.name === `player_${playerLetter}_action`)?.value;
    if (playerChoicesValue) {
        try {
            const choices = JSON.parse(playerChoicesValue.replace(/\\"/g, '"'));
            const radioGroup = document.createElement('div');
            radioGroup.className = 'mt-2';
            choices.forEach(choice => {
                const label = document.createElement('label');
                label.className = 'block';
                const input = document.createElement('input');
                input.type = 'radio';
                input.name = `player_${playerLetter}_action`;
                input.value = choice.replace('*', '');
                if (choice.startsWith('*')) input.checked = true;
                label.appendChild(input);
                label.append(` ${choice.replace('*', '')}`);
                radioGroup.appendChild(label);
            });
            inputArea.appendChild(radioGroup);
        } catch(e) {
            console.error("Could not parse choices: ", playerChoicesValue, e);
        }
    }

    const submitButton = document.createElement('button');
    submitButton.id = 'submit-multiplayer-action';
    submitButton.className = 'geems-button mt-4';
    submitButton.textContent = 'Submit Action';
    submitButton.onclick = submitMultiplayerAction;
    inputArea.appendChild(submitButton);
}

function handleDateUiUpdate(ui, turn) {
    multiplayerDateState.turn = turn;
    multiplayerDateState.currentTurnActions = {};
    multiplayerDateState.history.push({ui: ui});
    renderMultiplayerUI(ui);
}

async function handleDateAction(senderId, action) {
    if (!multiplayerDateState || multiplayerDateState.host !== MPLib.getLocalPeerId()) return;

    const playerIndex = multiplayerDateState.players.indexOf(senderId);
    const playerLetter = playerIndex === 0 ? 'a' : 'b';
    multiplayerDateState.currentTurnActions[playerLetter] = action;

    if (Object.keys(multiplayerDateState.currentTurnActions).length === multiplayerDateState.players.length) {
        showNotification("Both actions received. Generating next turn...", "info");
        multiplayerDateState.history[multiplayerDateState.history.length - 1].actions = { ...multiplayerDateState.currentTurnActions };

        const playerAProfile = "A new subject, probably full of predictable anxieties.";
        const playerBProfile = "Another new subject, let's see if they are any more interesting.";
        const dateHistory = multiplayerDateState.history.map(t => `UI: ${JSON.stringify(t.ui)}\nActions: ${JSON.stringify(t.actions)}`).join('\n---\n');

        const prompt = multiplayerDatePrompt
            .replace('Subject A Profile:', `Subject A Profile: ${playerAProfile}`)
            .replace('Subject B Profile:', `Subject B Profile: ${playerBProfile}`)
            .replace('Date History:', `Date History:\n${dateHistory}`)
            .replace('Subject A Action:', `Subject A Action: ${multiplayerDateState.currentTurnActions.a}`)
            .replace('Subject B Action:', `Subject B Action: ${multiplayerDateState.currentTurnActions.b}`);

        try {
            const apiKey = document.getElementById('apiKeyInput').value.trim();
            const newTurnUI = await callRealGeminiAPI(apiKey, prompt, AVAILABLE_MODELS[0]);
            const newTurnJson = JSON.parse(newTurnUI);

            const nextTurn = multiplayerDateState.turn + 1;
            const updatePayload = { type: 'date_ui_update', ui: newTurnJson, turn: nextTurn };

            multiplayerDateState.players.forEach(playerId => {
                if (playerId !== MPLib.getLocalPeerId()) MPLib.sendDirect(playerId, updatePayload);
            });
            handleDateUiUpdate(newTurnJson, nextTurn);

        } catch (error) {
            console.error("Error generating next date turn:", error);
            showError("An error occurred in the date.");
        }
    }
}

// --- Event Listeners & Main Setup ---
function setupEventListeners() {
    const sections = {
        lobby: document.getElementById('lobby'),
        date: document.getElementById('date'),
        history: document.getElementById('history'),
        multiplayerDate: document.getElementById('multiplayer-date')
    };

    function showSection(sectionToShow) {
        Object.values(sections).forEach(section => {
            section.style.display = section === sectionToShow ? 'block' : 'none';
        });
    }

    document.getElementById('nav-lobby').addEventListener('click', () => showSection(sections.lobby));
    document.getElementById('nav-date').addEventListener('click', () => showSection(sections.date));
    document.getElementById('nav-history').addEventListener('click', () => {
        showSection(sections.history);
        renderHistory();
    });

    document.getElementById('debug-mode-toggle').addEventListener('click', () => {
        debugMode = !debugMode;
        document.getElementById('debug-mode-toggle').textContent = `Debug Mode: ${debugMode ? 'ON' : 'OFF'}`;
    });

    document.getElementById('start-solo-date').addEventListener('click', () => {
        multiplayerDateState = null;
        showSection(sections.date);
    });
    document.getElementById('find-multiplayer-date').addEventListener('click', findMultiplayerDate);
}

function handleDataReceived(senderId, data) {
    switch (data.type) {
        case 'chat_message':
            // ...
            break;
        case 'date_request':
            if (confirm(`Accept date request from ${data.from.slice(-6)}?`)) {
                MPLib.sendDirect(data.from, { type: 'date_accept', from: MPLib.getLocalPeerId() });
                startMultiplayerDate(data.from, false); // Not the host
            } else {
                MPLib.sendDirect(data.from, { type: 'date_decline' });
            }
            break;
        case 'date_accept':
            showNotification(`${senderId.slice(-6)} accepted your date request!`, "success");
            startMultiplayerDate(senderId, true); // I am the host
            break;
        case 'date_decline':
            showNotification(`${senderId.slice(-6)} declined your date request.`, "warn");
            break;
        case 'date_action':
            if (multiplayerDateState && multiplayerDateState.host === MPLib.getLocalPeerId()) {
                handleDateAction(senderId, data.payload.action);
            }
            break;
        case 'date_ui_update':
            handleDateUiUpdate(data.ui, data.turn);
            break;
        default:
            console.warn(`Received unknown message type '${data.type}' from ${senderId.slice(-6)}`);
    }
}

function initializeGame() {
    console.log("Initializing Echidna's Embrace...");
    setupEventListeners();
    document.getElementById('lobby').style.display = 'block';
    document.getElementById('date').style.display = 'none';
    document.getElementById('history').style.display = 'none';
    document.getElementById('multiplayer-date').style.display = 'none';

    MPLib.initialize({
        targetHostId: DEFAULT_HOST_ID,
        debugLevel: 1,
        onDataReceived: handleDataReceived,
        // ... other handlers
    });
}

document.addEventListener('DOMContentLoaded', initializeGame);
