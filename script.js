// Frontend controller: upload/progress/stream + Player + Timestamp Filter

// Null-safe element retrieval with error handling
const form = document.getElementById('form');
const videoInput = document.getElementById('video');
const urlInput = document.getElementById('url');
const promptInput = document.getElementById('prompt');

const dropZone = document.getElementById('dropZone');
const browseBtn = document.getElementById('browseBtn');
const fileInfo = document.getElementById('fileInfo');

// Validate critical elements exist
if (!form || !videoInput || !urlInput || !promptInput || !dropZone || !browseBtn || !fileInfo) {
  console.error('Critical DOM elements missing. Please refresh the page.');
  showToast('Page initialization error. Please refresh.', 5000);
}

// Progress modal elements
const progressModal = document.getElementById('progressModal');
const progressPercent = document.getElementById('progressPercent');
const progressStatus = document.getElementById('progressStatus');
const progressLinearBar = document.getElementById('progressLinearBar');
const modalStepper = document.getElementById('modalStepper');

// Track progress state for smooth animations
let currentProgress = 0;
let targetProgress = 0;
let progressAnimationId = null;

const resultsPre = document.getElementById('results');
const timestampCardsContainer = document.getElementById('timestampCards');
const summaryEl = document.getElementById('summary');
const metaBody = document.getElementById('metaBody');
const metaTableWrap = document.getElementById('meta');

const tsFilterBtn = document.getElementById('tsFilterBtn');
const tsFilterDropdown = document.getElementById('tsFilterDropdown');
const activeFilterPill = document.getElementById('activeFilterPill');
let activeTsFilter = 'all';

const player = document.getElementById('player');
const ytWrap = document.getElementById('ytWrap');
const ytFrame = document.getElementById('ytFrame');

const submitBtn = document.getElementById('submitBtn');
const clearBtn = document.getElementById('clearBtn');
const shareBtn = document.getElementById('shareBtn');
const newAnalysisBtn = document.getElementById('newAnalysisBtn');
const newAnalysisBtnSide = document.getElementById('newAnalysisBtnSide');

// History panel elements
const historyList = document.getElementById('historyList');
const historySearchInput = document.getElementById('historySearchInput');
const historyStorageBar = document.getElementById('historyStorageBar');
const historyStorageText = document.getElementById('historyStorageText');
const TOTAL_STORAGE_BYTES = 20 * 1024 * 1024 * 1024; // 20 GB

// Current loaded job ID for sharing
let currentLoadedJobId = null;

// Track object URLs for cleanup
const activeObjectURLs = new Set();

// Delete progress modal elements
const deleteProgressModal = document.getElementById('deleteProgressModal');
const deleteProgressBar = document.getElementById('deleteProgressBar');
const deleteProgressPercent = document.getElementById('deleteProgressPercent');
const deleteStatus = document.getElementById('deleteStatus');
const deleteMessage = document.getElementById('deleteMessage');

// Tab functionality (results inner tabs)
const tabs = Array.from(document.querySelectorAll('.tab'));
const tabContents = Array.from(document.querySelectorAll('.tab-content'));

// Main tabs (Analyze / Results)
const mainTabs = Array.from(document.querySelectorAll('[data-tab-main]'));
const mainTabContents = Array.from(document.querySelectorAll('.main-tab-content'));

tabs.forEach(tab => {
  tab.addEventListener('click', () => {
    tabs.forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    tabContents.forEach(c => c.classList.remove('active'));
    document.getElementById(`tab-${tab.dataset.tab}`).classList.add('active');
  });
});

mainTabs.forEach(btn => {
  btn.addEventListener('click', () => {
    mainTabs.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    mainTabContents.forEach(c => c.classList.remove('active'));
    document.getElementById(`tab-${btn.dataset.tabMain}-main`).classList.add('active');
  });
});

function showToast(msg, duration = 3000) {
  const toast = document.getElementById('toast');
  if (!toast) return;
  toast.textContent = msg;
  toast.classList.remove('hidden');
  
  // Use requestAnimationFrame to ensure the transition works
  requestAnimationFrame(() => {
    setTimeout(() => {
      toast.classList.add('hidden');
    }, duration);
  });
}

// Delete progress animation function
async function showDeleteProgress(itemName, deleteFn) {
  if (!deleteProgressModal || !deleteProgressBar || !deleteProgressPercent) return;
  
  // Show modal
  deleteProgressModal.classList.remove('hidden');
  deleteProgressBar.style.width = '0%';
  deleteProgressPercent.textContent = '0%';
  deleteStatus.textContent = 'Deleting...';
  deleteMessage.textContent = 'Preparing to remove files...';
  
  // Animate progress through stages
  const stages = [
    { progress: 20, message: 'Removing job data...' },
    { progress: 45, message: 'Deleting video file...' },
    { progress: 70, message: 'Cleaning up Gemini files...' },
    { progress: 90, message: 'Finalizing deletion...' },
    { progress: 100, message: 'Complete!' }
  ];
  
  // Animate through stages with smooth transitions
  for (let i = 0; i < stages.length; i++) {
    const stage = stages[i];
    await new Promise(resolve => {
      // Smooth animation to target progress
      let current = parseFloat(deleteProgressBar.style.width) || 0;
      const target = stage.progress;
      const duration = i === stages.length - 1 ? 800 : 600; // Last stage slower
      const startTime = Date.now();
      
      const animate = () => {
        const elapsed = Date.now() - startTime;
        const progress = Math.min(elapsed / duration, 1);
        
        // Use ease-out for smooth deceleration
        const eased = 1 - Math.pow(1 - progress, 3);
        const value = current + (target - current) * eased;
        
        deleteProgressBar.style.width = `${value}%`;
        deleteProgressPercent.textContent = `${Math.round(value)}%`;
        
        if (progress < 1) {
          requestAnimationFrame(animate);
        } else {
          deleteProgressBar.style.width = `${target}%`;
          deleteProgressPercent.textContent = `${target}%`;
          deleteMessage.textContent = stage.message;
          resolve();
        }
      };
      
      requestAnimationFrame(animate);
    });
    
    // Small delay between stages (except before the actual delete)
    if (i === 2) {
      // At 70%, actually perform the delete
      try {
        await deleteFn();
      } catch (err) {
        deleteStatus.textContent = 'Error!';
        deleteMessage.textContent = err.message || 'Deletion failed';
        deleteProgressBar.style.background = 'linear-gradient(90deg, #ff4444 0%, #cc0000 100%)';
        await new Promise(resolve => setTimeout(resolve, 2000));
        deleteProgressModal.classList.add('hidden');
        throw err;
      }
    } else if (i < stages.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 300));
    }
  }
  
  // Show success briefly
  deleteStatus.textContent = 'Deleted!';
  deleteStatus.style.color = 'var(--ok)';
  await new Promise(resolve => setTimeout(resolve, 800));
  
  // Hide modal with fade out
  deleteProgressModal.classList.add('hidden');
  
  // Reset for next time
  setTimeout(() => {
    deleteProgressBar.style.width = '0%';
    deleteProgressBar.style.background = 'linear-gradient(90deg, #ff5d66 0%, #ff6b6b 50%, #ff8787 100%)';
    deleteProgressPercent.textContent = '0%';
    deleteStatus.textContent = 'Deleting...';
    deleteStatus.style.color = '';
    deleteMessage.textContent = 'Removing files...';
  }, 300);
}

// Step progress ranges
const STEP_PROGRESS = {
  'queued': { start: 0, end: 15 },
  'uploading': { start: 15, end: 40 },
  'processing': { start: 40, end: 65 },
  'analyzing': { start: 65, end: 95 },
  'complete': { start: 100, end: 100 },
  'failed': { start: 0, end: 0 }
};

function updateStepper(activeStep) {
  if (!modalStepper) return;
  const steps = ['queued', 'uploading', 'processing', 'analyzing'];
  const activeIndex = steps.indexOf(activeStep);

  modalStepper.querySelectorAll('.step').forEach(li => {
    const stepName = li.dataset.step;
    const stepIndex = steps.indexOf(stepName);

    li.classList.remove('active', 'done');

    // If activeStep is 'complete' or not found, mark all as done
    if (activeIndex === -1 || activeStep === 'complete') {
      li.classList.add('done');
    } else if (stepIndex < activeIndex) {
      li.classList.add('done'); // Mark all previous steps as done
    } else if (stepIndex === activeIndex) {
      li.classList.add('active'); // Mark current step as active
    }
  });
}

// Smooth progress bar animation
function animateProgress(targetPct) {
  targetProgress = Math.max(0, Math.min(100, targetPct));
  
  // Cancel existing animation
  if (progressAnimationId) {
    cancelAnimationFrame(progressAnimationId);
  }

  function update() {
    const diff = targetProgress - currentProgress;
    const isNearTarget = Math.abs(diff) < 0.05;
    
    if (isNearTarget) {
      // When very close to target, snap to exact value
      currentProgress = targetProgress;
      if (progressLinearBar) {
        progressLinearBar.style.width = `${currentProgress}%`;
      }
      if (progressPercent) {
        // Round to whole number when complete
        progressPercent.textContent = `${Math.round(currentProgress)}%`;
      }
      progressAnimationId = null;
      return;
    }

    // Smooth interpolation (easing) - slower for smoother animation
    const easeFactor = 0.12; // Lower = smoother but slower
    currentProgress += diff * easeFactor;
    
    // Clamp to 0-100 range
    currentProgress = Math.max(0, Math.min(100, currentProgress));
    
    // Update bar with smooth width
    if (progressLinearBar) {
      progressLinearBar.style.width = `${currentProgress}%`;
    }
    
    // Update percentage with smooth animation
    if (progressPercent) {
      // Show one decimal place during animation for smoothness
      // Only round to whole number when very close to target
      if (isNearTarget || Math.abs(diff) < 1) {
        progressPercent.textContent = `${Math.round(currentProgress)}%`;
      } else {
        // Show one decimal during animation
        progressPercent.textContent = `${currentProgress.toFixed(1)}%`;
      }
    }

    progressAnimationId = requestAnimationFrame(update);
  }

  update();
}

// Calculate progress based on step and elapsed time
function calculateProgress(activeStep, startTime = null) {
  const stepInfo = STEP_PROGRESS[activeStep] || STEP_PROGRESS['queued'];
  
  if (activeStep === 'complete') {
    return 100;
  }
  
  if (activeStep === 'failed') {
    return stepInfo.start;
  }

  // For active steps, gradually increase progress within the step range
  // Use a smooth upward trend with a subtle pulse effect
  if (startTime) {
    const elapsed = Date.now() - startTime;
    const stepDuration = 3000; // 3 seconds for smoother progression
    const progressInStep = Math.min(elapsed / stepDuration, 1); // Clamp to 1
    
    // Base progress: gradually fill the step range
    const baseProgress = stepInfo.start + (stepInfo.end - stepInfo.start) * Math.min(progressInStep * 0.7, 0.7);
    
    // Add subtle pulse that never goes below base (only adds, doesn't subtract)
    const pulse = Math.sin((elapsed / 1000) * Math.PI * 2) * 0.05; // 5% pulse, smaller
    const pulseAdd = Math.max(0, pulse); // Only positive pulses
    
    return Math.min(baseProgress + pulseAdd * (stepInfo.end - stepInfo.start), stepInfo.end);
  }

  // Default: show progress at start of current step
  return stepInfo.start;
}

// Track step start time for smooth progress animation
let stepStartTime = Date.now();
let currentStep = 'queued';
let progressUpdateInterval = null;

// New progress modal controller
function setUpload(pct, label) {
  // Show/Hide modal logic
  if (pct > 0 && progressModal.classList.contains('hidden')) {
    progressModal.classList.remove('hidden');
    progressModal.style.opacity = '1';
    currentProgress = 0;
    targetProgress = 0;
    stepStartTime = Date.now();
  }
  if (pct <= 0 && !progressModal.classList.contains('hidden')) {
    progressModal.style.opacity = '0';
    setTimeout(() => {
      progressModal.classList.add('hidden');
      // Reset progress
      currentProgress = 0;
      targetProgress = 0;
      if (progressLinearBar) progressLinearBar.style.width = '0%';
      if (progressPercent) progressPercent.textContent = '0%';
    }, 300);
  }

  // Update main status text
  if (progressStatus && progressStatus.textContent !== label) {
    progressStatus.classList.remove('animate-fade-in');
    void progressStatus.offsetWidth;
    progressStatus.textContent = label;
    progressStatus.classList.add('animate-fade-in');
  }

  // --- STEPPER AND PROGRESS BAR LOGIC ---
  const lowerLabel = (label || '').toLowerCase();
  let detectedStep = currentStep;

  if (lowerLabel.includes('queued')) {
    detectedStep = 'queued';
    updateStepper('queued');
  } else if (lowerLabel.includes('uploading')) {
    detectedStep = 'uploading';
    updateStepper('uploading');
  } else if (lowerLabel.includes('waiting') || lowerLabel.includes('processing')) {
    detectedStep = 'processing';
    updateStepper('processing');
  } else if (lowerLabel.includes('analyzing')) {
    detectedStep = 'analyzing';
    updateStepper('analyzing');
  } else if (lowerLabel.includes('complete')) {
    detectedStep = 'complete';
    updateStepper('complete');
  } else if (lowerLabel.includes('failed')) {
    detectedStep = 'failed';
    updateStepper('complete'); // Show all steps but mark as done
  }

  // Reset step timer if step changed
  if (detectedStep !== currentStep) {
    currentStep = detectedStep;
    stepStartTime = Date.now();
  }

  // Calculate and animate progress
  const targetPct = calculateProgress(detectedStep, stepStartTime);
  animateProgress(targetPct);

  // Start continuous progress updates if modal is visible
  if (pct > 0 && !progressUpdateInterval) {
    progressUpdateInterval = setInterval(() => {
      if (!progressModal.classList.contains('hidden')) {
        const targetPct = calculateProgress(currentStep, stepStartTime);
        animateProgress(targetPct);
      } else {
        // Stop interval if modal is hidden
        if (progressUpdateInterval) {
          clearInterval(progressUpdateInterval);
          progressUpdateInterval = null;
        }
      }
    }, 100); // Update every 100ms for smooth animation
  }

  // Stop interval when modal is hidden
  if (pct <= 0 && progressUpdateInterval) {
    clearInterval(progressUpdateInterval);
    progressUpdateInterval = null;
  }
}

function loadJobIntoUI(item) {
  if (!item || !item.id) {
    console.warn('Invalid item passed to loadJobIntoUI');
    showToast('Invalid job data. Please try again.');
    return;
  }
  
  try {
    currentLoadedJobId = String(item.id);
    localStorage.setItem('currentHistoryItemId', currentLoadedJobId);

    // 1. Reset inputs and set results text
    resetInputsOnly();
    if (resultsPre) {
      const analysisText = (item.analysisText || '').slice(0, 500000); // Safety limit
      resultsPre.textContent = analysisText;
    }
    buildStructuredOutput(item.analysisText || '');

    // 2. Set up player
    if (item.videoUrl && typeof item.videoUrl === 'string') {
      if (isYouTubeUrl(item.videoUrl)) {
        if (urlInput) urlInput.value = item.videoUrl;
        const embed = toYouTubeEmbed(item.videoUrl);
        if (embed && ytFrame && ytWrap && player) {
          ytFrame.src = embed;
          ytWrap.classList.remove('hidden');
          player.classList.add('hidden');
        }
      } else if (item.fileName && item.videoUrl.startsWith('/shared/')) {
        if (player && ytWrap && fileInfo) {
          player.src = item.videoUrl;
          player.classList.remove('hidden');
          ytWrap.classList.add('hidden');
          const safeFileName = String(item.fileName || 'Saved video').slice(0, 100);
          fileInfo.textContent = `Loaded from history: ${safeFileName}`;
          fileInfo.classList.remove('hidden');
        }
      }
    }

    // 3. Enable sharing
    if (shareBtn) shareBtn.disabled = false;

    // 4. Switch to the Results tab
    if (mainTabs.length > 0) mainTabs.forEach(b => b.classList.remove('active'));
    const resultsTab = document.querySelector('[data-tab-main="results"]');
    if (resultsTab) resultsTab.classList.add('active');
    if (mainTabContents.length > 0) mainTabContents.forEach(c => c.classList.remove('active'));
    const resultsContent = document.getElementById('tab-results-main');
    if (resultsContent) resultsContent.classList.add('active');

    // 5. Ensure "Structured" tab is active
    if (tabs.length > 0) tabs.forEach(t => t.classList.remove('active'));
    if (tabContents.length > 0) tabContents.forEach(c => c.classList.remove('active'));
    const structuredTab = document.querySelector('.tab[data-tab="structured"]');
    const structuredContent = document.getElementById('tab-structured');
    if (structuredTab) structuredTab.classList.add('active');
    if (structuredContent) structuredContent.classList.add('active');
  } catch (error) {
    console.error('Error loading job into UI:', error);
    showToast('Error loading job data. Please try again.', 5000);
  }
}

// Track active polling intervals to prevent memory leaks
const activePollIntervals = new Map();

function pollJobStatus(jobId) {
  // Clear any existing interval for this jobId (prevent duplicates)
  if (activePollIntervals.has(jobId)) {
    clearInterval(activePollIntervals.get(jobId));
  }

  let pollCount = 0;
  const maxPolls = 600; // Max 30 minutes (600 * 3 seconds)
  
  const interval = setInterval(async () => {
    pollCount++;
    
    // Safety: stop polling after max attempts
    if (pollCount > maxPolls) {
      clearInterval(interval);
      activePollIntervals.delete(jobId);
      setUpload(0, 'Idle');
      showToast('Analysis timed out. Please try again.');
      return;
    }

    try {
      const res = await fetch(`/api/job/status/${jobId}`);
      if (!res.ok) {
        // If 404, job might have been deleted, stop polling
        if (res.status === 404) {
          clearInterval(interval);
          activePollIntervals.delete(jobId);
          setUpload(0, 'Idle');
          showToast('Job not found.');
          return;
        }
        return; // Keep polling for other errors
      }

      const job = await res.json();

      // Update progress modal
      let pct = 15;
      if (job.status === 'PROCESSING') {
        const label = (job.progressLabel || 'Processing...').toLowerCase();
        if (label.includes('uploading')) pct = 30;
        else if (label.includes('waiting')) pct = 50;
        else if (label.includes('analyzing')) pct = 75;
      }
      setUpload(pct, job.progressLabel || '...');

      // Update history list in real-time
      await renderHistory();

      if (job.status === 'COMPLETE' || job.status === 'FAILED') {
        clearInterval(interval);
        activePollIntervals.delete(jobId);
        setUpload(100, job.status === 'COMPLETE' ? 'Complete ✓' : 'Failed');

        if (job.status === 'FAILED') {
          showToast(`Analysis Failed: ${job.analysisText || 'Unknown error'}`);
        } else {
          // Load the completed job data into the UI
          loadJobIntoUI(job);
        }

        setTimeout(() => setUpload(0, 'Idle'), 1500);
      }
    } catch (e) {
      // Network error, just keep polling (but log for debugging)
      if (pollCount % 20 === 0) { // Log every 60 seconds
        console.warn(`Polling error for job ${jobId}:`, e);
      }
    }
  }, 3000); // Poll every 3 seconds

  activePollIntervals.set(jobId, interval);
}

// Helper for the new function
function isYouTubeUrl(url) {
    try {
        const u = new URL(url);
        const host = u.hostname.replace(/^www\./, '');
        return (host === 'youtube.com' || host === 'm.youtube.com' || host === 'youtu.be');
    } catch { return false; }
}

// Browse button click handler
browseBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  videoInput.click();
});

// Dropzone click handler - click anywhere on dropzone to open file picker
dropZone.addEventListener('click', (e) => {
  // Don't trigger if clicking the browse button (it has its own handler)
  if (e.target === browseBtn || e.target.closest('#browseBtn')) {
    return;
  }
  videoInput.click();
});

// File input change handler
videoInput.addEventListener('change', (e) => {
  const input = e.target;
  if (input.files && input.files.length > 0) {
    const file = input.files[0];
    
    // Validate file type
    if (!file.type.startsWith('video/')) {
      showToast('Please select a valid video file.');
      input.value = ''; // Clear invalid selection
      return;
    }
    
    // Validate file size (optional - 500MB limit)
    const maxSize = 500 * 1024 * 1024; // 500MB
    if (file.size > maxSize) {
      showToast('File size exceeds 500MB limit. Please select a smaller video.');
      input.value = '';
      return;
    }
    
    // Display file info
    const fileSizeMB = (file.size / 1024 / 1024).toFixed(2);
    fileInfo.textContent = `✓ ${file.name} (${fileSizeMB} MB)`;
    fileInfo.classList.remove('hidden');
    
    // Clear YouTube URL if file is selected
    ytWrap.classList.add('hidden');
    ytFrame.removeAttribute('src');
    urlInput.value = '';
    
    // Cleanup previous object URL
    if (player.src && player.src.startsWith('blob:')) {
      if (activeObjectURLs.has(player.src)) {
        URL.revokeObjectURL(player.src);
        activeObjectURLs.delete(player.src);
      }
    }
    
    try {
      const url = URL.createObjectURL(file);
      activeObjectURLs.add(url);
      player.src = url;
      player.classList.remove('hidden');
      player.load(); // Reload the video element
    } catch (error) {
      console.error('Error loading video:', error);
      showToast('Error loading video file. Please try again.');
    }
  }
});

['dragenter', 'dragover'].forEach(ev => {
  dropZone.addEventListener(ev, e => { 
    e.preventDefault(); 
    e.stopPropagation();
    dropZone.classList.add('drag-over'); 
  });
});
['dragleave', 'drop'].forEach(ev => {
  dropZone.addEventListener(ev, e => { 
    e.preventDefault(); 
    e.stopPropagation();
    dropZone.classList.remove('drag-over', 'hover'); 
  });
});
dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  e.stopPropagation();
  dropZone.classList.remove('drag-over');
  
  const dt = e.dataTransfer;
  if (dt && dt.files && dt.files.length > 0) {
    const file = dt.files[0];
    
    // Validate file type
    if (!file.type.startsWith('video/')) {
      showToast('Please drop a video file.');
      return;
    }
    
    // Create a new FileList using DataTransfer
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(file);
    videoInput.files = dataTransfer.files;
    
    // Trigger change event
    videoInput.dispatchEvent(new Event('change', { bubbles: true }));
  }
});

// Removed chips (prompt suggestions)

// Helper: reset inputs only (keep results)
function resetInputsOnly() {
  if (promptInput) promptInput.value = '';
  if (urlInput) urlInput.value = '';
  if (videoInput) videoInput.value = '';
  if (fileInfo) {
    fileInfo.textContent = '';
    fileInfo.classList.add('hidden');
  }
  
  // Cleanup video player and object URLs
  if (player) {
    player.pause();
    if (player.src && player.src.startsWith('blob:')) {
      if (activeObjectURLs.has(player.src)) {
        URL.revokeObjectURL(player.src);
        activeObjectURLs.delete(player.src);
      }
    }
    player.removeAttribute('src');
    player.classList.add('hidden');
  }
  
  if (ytFrame) ytFrame.removeAttribute('src');
  if (ytWrap) ytWrap.classList.add('hidden');
}

// New Analysis: reset inputs only (keep existing results visible in Results tab)
function startNewAnalysis() {
  resetInputsOnly();
  currentLoadedJobId = null;
  // Switch to Analyze tab to start a new run
  mainTabs.forEach(b => b.classList.remove('active'));
  document.querySelector('[data-tab-main="analyze"]').classList.add('active');
  mainTabContents.forEach(c => c.classList.remove('active'));
  document.getElementById('tab-analyze-main').classList.add('active');
}

newAnalysisBtn?.addEventListener('click', startNewAnalysis);
newAnalysisBtnSide?.addEventListener('click', startNewAnalysis);

if (clearBtn) {
  clearBtn.addEventListener('click', () => {
    // Clear inputs safely
    if (promptInput) promptInput.value = '';
    if (urlInput) urlInput.value = '';
    if (videoInput) videoInput.value = '';
    if (fileInfo) {
      fileInfo.textContent = '';
      fileInfo.classList.add('hidden');
    }
    if (resultsPre) resultsPre.textContent = '';
    setUpload(0, 'Idle');
    
    // Cleanup video player and object URLs
    if (player) {
      player.pause();
      if (player.src && player.src.startsWith('blob:')) {
        if (activeObjectURLs.has(player.src)) {
          URL.revokeObjectURL(player.src);
          activeObjectURLs.delete(player.src);
        }
      }
      player.removeAttribute('src');
      player.classList.add('hidden');
    }
    
    if (ytFrame) ytFrame.removeAttribute('src');
    if (ytWrap) ytWrap.classList.add('hidden');
    
    activeTsFilter = 'all';
    currentLoadedJobId = null;
    if (activeFilterPill) activeFilterPill.textContent = 'All';
    buildStructuredOutput(''); // Clear structured view
    
    if (tabs.length > 0) tabs.forEach(t => t.classList.remove('active'));
    if (tabContents.length > 0) tabContents.forEach(c => c.classList.remove('active'));
    
    const structuredTab = document.querySelector('.tab[data-tab="structured"]');
    const structuredContent = document.getElementById('tab-structured');
    if (structuredTab) structuredTab.classList.add('active');
    if (structuredContent) structuredContent.classList.add('active');
    
    if (shareBtn) shareBtn.disabled = true;
  });
}

function toYouTubeEmbed(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, '');
    if (host === 'youtube.com' || host === 'm.youtube.com') {
      const v = u.searchParams.get('v');
      if (v) return `https://www.youtube.com/embed/${v}`;
    }
    if (host === 'youtu.be') {
      const id = u.pathname.split('/').filter(Boolean)[0];
      if (id) return `https://www.youtube.com/embed/${id}`;
    }
  } catch {}
  return '';
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  
  // Validate form exists
  if (!form || !submitBtn) {
    showToast('Form not initialized. Please refresh the page.');
    return;
  }
  
  // Prevent double submission
  if (submitBtn.disabled) {
    showToast('Please wait for the current analysis to complete.');
    return;
  }
  
  // Sanitize inputs
  const prompt = (promptInput?.value || '').trim();
  const url = (urlInput?.value || '').trim();
  const file = videoInput?.files && videoInput.files[0];

  // Validate prompt length
  if (prompt.length > 5000) {
    showToast('Additional instructions must be less than 5000 characters.');
    return;
  }

  // Validate URL length
  if (url.length > 2048) {
    showToast('URL is too long. Please use a valid YouTube URL.');
    return;
  }

  if (resultsPre) resultsPre.textContent = '';
  setUpload(10, 'Preparing…');
  if (shareBtn) shareBtn.disabled = true;

  // Validation
  if (file && url) { 
    showToast('Provide either a file OR a YouTube URL, not both.'); 
    setUpload(0, 'Idle'); 
    if (shareBtn) shareBtn.disabled = false;
    return; 
  }
  if (!file && !url) { 
    showToast('Please select a video or enter a YouTube URL.'); 
    setUpload(0, 'Idle'); 
    if (shareBtn) shareBtn.disabled = false;
    return; 
  }
  
  // Validate URL format if provided
  if (url && !isYouTubeUrl(url)) {
    showToast('Please enter a valid YouTube URL (youtube.com or youtu.be).');
    setUpload(0, 'Idle');
    if (shareBtn) shareBtn.disabled = false;
    return;
  }

  // Player logic
  if (file) {
    // Cleanup previous object URL
    if (player.src && player.src.startsWith('blob:')) {
      if (activeObjectURLs.has(player.src)) {
        URL.revokeObjectURL(player.src);
        activeObjectURLs.delete(player.src);
      }
    }
    
    const objUrl = URL.createObjectURL(file);
    activeObjectURLs.add(objUrl);
    player.src = objUrl;
    player.classList.remove('hidden');
    if (ytFrame) ytFrame.removeAttribute('src');
    if (ytWrap) ytWrap.classList.add('hidden');
  } else {
    // Cleanup object URLs when switching to YouTube
    if (player.src && player.src.startsWith('blob:')) {
      if (activeObjectURLs.has(player.src)) {
        URL.revokeObjectURL(player.src);
        activeObjectURLs.delete(player.src);
      }
      player.removeAttribute('src');
    }
    
    const embed = toYouTubeEmbed(url);
    if (embed && ytFrame) {
      ytFrame.src = embed;
      if (ytWrap) ytWrap.classList.remove('hidden');
      if (player) {
        player.pause();
        player.classList.add('hidden');
      }
    }
  }

  try {
    submitBtn.disabled = true;
    setUpload(12, 'Uploading & Queuing...');

    const fd = new FormData();
    fd.append('prompt', prompt);
    if (file) fd.append('video', file);
    if (url) fd.append('url', url);

    const res = await fetch('/upload', { method: 'POST', body: fd });

    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      const msg = j?.message || `Error ${res.status}`;
      showToast(msg);
      throw new Error(msg); // Go to catch block
    }

    // This is the new "instant" response
    const { jobId } = await res.json();

    setUpload(15, 'Job Queued. Waiting...');

    // Auto-switch to results tab to watch progress
        mainTabs.forEach(b => b.classList.remove('active'));
        document.querySelector('[data-tab-main="results"]').classList.add('active');
        mainTabContents.forEach(c => c.classList.remove('active'));
        document.getElementById('tab-results-main').classList.add('active');

    // Update history (it will show as "QUEUED")
    await renderHistory();

    // Start polling for the result
    pollJobStatus(jobId);

  } catch (err) {
    setUpload(0, 'Idle'); // Reset on error
    console.error('Form submission error:', err);
    const errorMsg = err.message || 'An unexpected error occurred. Please try again.';
    showToast(errorMsg, 5000);
    
    // Cleanup on error
    if (shareBtn) shareBtn.disabled = false;
  } finally {
    if (submitBtn) submitBtn.disabled = false;
    // The modal is now controlled by the poller, not the submit handler
  }
});

// Cleanup object URLs on page unload
window.addEventListener('beforeunload', () => {
  activeObjectURLs.forEach(url => {
    try {
      URL.revokeObjectURL(url);
    } catch (e) {
      console.warn('Error revoking object URL:', e);
    }
  });
  activeObjectURLs.clear();
  
  // Cleanup all polling intervals
  activePollIntervals.forEach((interval) => {
    clearInterval(interval);
  });
  activePollIntervals.clear();
});

/* =========================================
   ROBUST PARSING & RENDERING LOGIC
   ========================================= */

function escapeHTML(s) { return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

// Convert simple markdown-like markers to styled pills/tags
function parseAndPill(text) {
  const safe = escapeHTML(text || '');
  // **bold** -> strong pill
  let out = safe.replace(/\*\*(.+?)\*\*/g, (_m, p1) => `<strong class="pill-strong">${p1}</strong>`);
  // Lines starting with * item -> pill-item block
  out = out.replace(/^\*\s+(.+)$/gm, (_m, p1) => `<div class="pill-item">${p1}</div>`);
  // Newlines to <br>
  out = out.replace(/\r?\n/g, '<br>');
  return out;
}

function categoryClass(category) {
  const c = (category || '').toLowerCase();
  if (/911/.test(c)) return 'cat-911';
  if (/investigation/.test(c)) return 'cat-investigation';
  if (/interrogation/.test(c)) return 'cat-interrogation';
  if (/cctv|footage/.test(c)) return 'cat-cctv';
  if (/body\s*cam/.test(c)) return 'cat-bodycam';
  return '';
}

function parseGeminiOutput(text) {
    if (!text) return { metadata: {}, timestamps: [], summary: '' };

    const lines = text.split(/\r?\n/);
    let metadata = {};
    let timestamps = [];
    let summary = '';

    let currentSection = '';
    let currentCategory = 'General';

    // A helper to strip asterisks and whitespace from the start/end
    const clean = (s) => (s || '').trim().replace(/^[\*\s]+|[\*\s]+$/g, '');

    for (const line of lines) {
        const trimmedLine = line.trim();
        const upperLine = trimmedLine.toUpperCase();

        if (trimmedLine.length === 0) continue;

        // *** FIX IS HERE: Reverted from startsWith to includes ***
        if (upperLine.includes('METADATA') && !upperLine.includes('EXTRACTION')) {
            currentSection = 'METADATA';
            continue;
        } else if (upperLine.includes('TIMESTAMPS')) {
            currentSection = 'TIMESTAMPS';
            continue;
        } else if (upperLine.includes('SUMMARY') || upperLine.includes('STORYLINE')) {
            currentSection = 'SUMMARY';
            
            // Clean the header line itself
            let summaryPart = line.split(/AND STORYLINE|SUMMARY/i).pop() || '';
            summaryPart = summaryPart.replace(/^[\*\s:]+/g, ''); // Remove `**:`
            
            if (summaryPart.trim()) {
                summary += summaryPart.trim() + '\n';
            }
            continue;
        }

        switch (currentSection) {
            case 'METADATA':
                const metaMatch = trimmedLine.match(/^[\*\-\s]*([^:]+?)\s*:\s*(.*)/);
                
                if (metaMatch && metaMatch[2] && metaMatch[2].trim()) {
                    const key = clean(metaMatch[1]);
                    const value = clean(metaMatch[2]);
                    
                    if (key && value && !/\[extracted.*\]/i.test(value)) {
                         metadata[key] = value;
                    }
                }
                break;

            case 'TIMESTAMPS':
                const categoryMatch = trimmedLine.match(/^\s*(?:\*{1,3}|#{1,3})\s*(?:\d+\.?\s*)?([A-Z0-9\s/&-]+)\s*(?:\*{1,3}|:)?\s*$/i);
                if (categoryMatch && !trimmedLine.includes('[')) {
                    currentCategory = categoryMatch[1].trim();
                    continue;
                }
                const tsMatch = trimmedLine.match(/\[([^\]]+)\]\s*-\s*(.+)/);
                if (tsMatch) {
                    let description = tsMatch[2].trim();
                    let finalCategory = currentCategory;
                    const descParts = description.split(/\s*-\s*/);
                    if (descParts.length > 1) {
                         if (descParts[0].trim().toUpperCase() === currentCategory.toUpperCase()) {
                            description = descParts.slice(1).join(' - ').trim();
                        } else {
                           finalCategory = descParts[0].trim();
                           description = descParts.slice(1).join(' - ').trim();
                        }
                    }
                    timestamps.push({
                        time: tsMatch[1],
                        category: finalCategory,
                        description: description
                    });
                }
                break;

            case 'SUMMARY':
                summary += line + '\n';
                break;
        }
    }
    
    // Final cleanup of the whole summary string
    const finalSummary = summary.trim().replace(/^[\*\s]+|[\*\s]+$/g, '');
    
    return { metadata, timestamps, summary: finalSummary };
}


function buildStructuredOutput(text) {
  if (!text || typeof text !== 'string') {
    text = '';
  }
  
  try {
    const { metadata, timestamps, summary } = parseGeminiOutput(text);

    if (summaryEl) {
      summaryEl.innerHTML = parseAndPill(summary || '—');
    }

    if (Object.keys(metadata).length > 0) {
      if (metaTableWrap) metaTableWrap.classList.remove('hidden');
      let metaHtml = '';
      for (const [key, value] of Object.entries(metadata)) {
        const safeKey = escapeHTML(String(key || '').slice(0, 100));
        const safeValue = String(value || '').slice(0, 1000);
        metaHtml += `<tr><td><span class="pill-key">${safeKey}</span></td><td>${parseAndPill(safeValue)}</td></tr>`;
      }
      if (metaBody) metaBody.innerHTML = metaHtml;
    } else {
      if (metaTableWrap) metaTableWrap.classList.add('hidden');
      if (metaBody) metaBody.innerHTML = '';
    }
  
    // Normalize timestamps to ensure ranges: if no end time, use next start time
    const normalized = (() => {
      const withStart = timestamps.map((t, i) => ({ ...t, __idx: i, __start: timeToSeconds(t.time) }));
      const sorted = [...withStart].sort((a, b) => a.__start - b.__start);
      const idxToDisplay = new Map();
      for (let i = 0; i < sorted.length; i++) {
        const cur = sorted[i];
        const raw = String(cur.time || '');
        if (/\s-\s/.test(raw)) { // already a range
          idxToDisplay.set(cur.__idx, raw);
          continue;
        }
        const next = sorted[i + 1];
        if (next && isFinite(next.__start) && next.__start > cur.__start) {
          // Build HH:MM or MM:SS string for next start based on digits in current
          const toLabel = (secs) => {
            const h = Math.floor(secs / 3600); const m = Math.floor((secs % 3600) / 60); const s = Math.floor(secs % 60);
            if (h > 0) return `${String(h).padStart(1, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
            return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
          };
          const display = `${raw} - ${toLabel(next.__start)}`;
          idxToDisplay.set(cur.__idx, display);
        } else {
          idxToDisplay.set(cur.__idx, raw); // leave as-is for last item
        }
      }
      return withStart.map(t => ({ ...t, displayTime: idxToDisplay.get(t.__idx) || t.time }));
    })();

    const grouped = normalized.reduce((acc, ts) => {
      const cat = String(ts.category || '').trim().slice(0, 100);
      if (!cat) return acc;
      if (!acc[cat]) acc[cat] = [];
      acc[cat].push(ts);
      return acc;
    }, {});

    let cardsHtml = '';
    for (const category in grouped) {
      if (!passesFilter(category)) continue;

      const items = grouped[category];
      const safeCategory = escapeHTML(String(category || '').slice(0, 100));
      const count = items.length;
      
      // Build entries HTML
      const entriesHtml = items.slice(0, 500).map(it => { // Limit to 500 items per category
        const label = escapeHTML(String(it.displayTime || it.time || '').slice(0, 50));
        const desc = escapeHTML(String(it.description || '').slice(0, 500));
        return `<div class="accordion-entry">
          <button class="accordion-entry-time ts-jump" data-ts="${label}" type="button">${label}</button>
          <div class="accordion-entry-description">${desc}</div>
        </div>`;
      }).join('');
      
      // Build accordion item HTML
      cardsHtml += `<div class="accordion-item">
        <button class="accordion-header" type="button" aria-expanded="false">
          <span class="accordion-icon"></span>
          <span class="accordion-title">
            <span>${safeCategory}</span>
            <span class="accordion-count">(${count})</span>
          </span>
        </button>
        <div class="accordion-content">
          <div class="accordion-content-inner">${entriesHtml}</div>
        </div>
      </div>`;
    }
    if (timestampCardsContainer) {
      // Wrap in accordion-container
      const accordionHtml = cardsHtml 
        ? `<div class="accordion-container">${cardsHtml}</div>`
        : `<div class="muted">No timestamps detected yet.</div>`;
      timestampCardsContainer.innerHTML = accordionHtml;
      
      // Initialize accordion functionality after rendering
      initializeAccordion();
    }
  } catch (error) {
    console.error('Error building structured output:', error);
    if (summaryEl) summaryEl.innerHTML = '<span class="muted">Error parsing analysis results.</span>';
    if (timestampCardsContainer) timestampCardsContainer.innerHTML = '<div class="muted">Error displaying timestamps.</div>';
  }
}

// Initialize accordion functionality
function initializeAccordion() {
  const accordionHeaders = document.querySelectorAll('.accordion-header');
  
  accordionHeaders.forEach(header => {
    header.addEventListener('click', () => {
      const isActive = header.classList.contains('active');
      const content = header.nextElementSibling;
      
      // Close all accordions first
      accordionHeaders.forEach(h => {
        const c = h.nextElementSibling;
        h.classList.remove('active');
        h.setAttribute('aria-expanded', 'false');
        if (c) {
          c.style.maxHeight = '0';
        }
      });
      
      // If the clicked header wasn't active, open it
      if (!isActive && content) {
        header.classList.add('active');
        header.setAttribute('aria-expanded', 'true');
        // Set max-height to scrollHeight for smooth expansion
        content.style.maxHeight = content.scrollHeight + 'px';
      }
    });
  });
}

function timeToSeconds(ts) {
  // Get just the start time, e.g., "00:45 - 01:00" -> "00:45"
  const startTime = (ts || '').split(' - ')[0].trim(); 
  
  const parts = (startTime || '').split(':').map(x => parseInt(x, 10));
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return 0;
}

timestampCardsContainer?.addEventListener('click', (e) => {
  const btn = e.target.closest('.ts-jump');
  if (!btn) return;
  const ts = btn.getAttribute('data-ts') || '';
  const secs = timeToSeconds(ts);
  if (!isNaN(secs)) {
    if (!player.classList.contains('hidden')) {
      try { player.currentTime = secs; player.play(); } catch {}
    } else if (!ytWrap.classList.contains('hidden')) {
      const cur = ytFrame.getAttribute('src') || '';
      if (cur) {
        const url = new URL(cur.split('?')[0]);
        url.searchParams.set('start', String(secs));
        url.searchParams.set('autoplay', '1');
        ytFrame.src = url.toString();
      }
    }
  }
});

tsFilterBtn?.addEventListener('click', () => {
  tsFilterDropdown.classList.toggle('hidden');
});

document.addEventListener('click', (e) => {
  if (!tsFilterDropdown) return;
  if (e.target === tsFilterBtn || tsFilterDropdown.contains(e.target)) return;
  tsFilterDropdown.classList.add('hidden');
});

tsFilterDropdown?.addEventListener('click', (e) => {
  const btn = e.target.closest('.filter-option');
  if (!btn) return;
  const val = btn.getAttribute('data-filter') || 'all';
  activeTsFilter = val;
  activeFilterPill.textContent = filterLabel(val);
  tsFilterDropdown.classList.add('hidden');
  buildStructuredOutput(resultsPre.textContent);
});

function filterLabel(val) {
  switch (val) {
    case '911_call': return '911 Call';
    case 'investigation': return 'Investigation';
    case 'interrogation': return 'Interrogation';
    case 'cctv': return 'CCTV';
    case 'body_cam': return 'Body Cam';
    default: return 'All';
  }
}

function passesFilter(category) {
  if (activeTsFilter === 'all') return true;
  const c = (category || '').toLowerCase();
  if (activeTsFilter === '911_call') return /911/.test(c);
  if (activeTsFilter === 'investigation') return /investigation/.test(c);
  if (activeTsFilter === 'interrogation') return /interrogation/.test(c);
  if (activeTsFilter === 'cctv') return /cctv|footage/.test(c);
  if (activeTsFilter === 'body_cam') return /body\s*cam/.test(c);
  return true;
}

document.getElementById('copyBtn')?.addEventListener('click', async () => {
  const text = resultsPre.textContent || '';
  try { await navigator.clipboard.writeText(text); showToast('Copied to clipboard.'); } catch { showToast('Copy failed.'); }
});

document.getElementById('saveBtn')?.addEventListener('click', () => {
  const text = resultsPre.textContent || '';
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `gemini-analysis-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;
  document.body.appendChild(a); a.click(); a.remove();
  showToast('File saved.');
});

async function shareAnalysis(jobId) {
  if (!jobId) {
    showToast('Please load an analysis to share.');
    return;
  }

  // 1. Create the new simple URL
  const viewUrl = new URL('view.html', window.location.href);
  viewUrl.searchParams.set('id', jobId);
  const fullUrl = viewUrl.href;

  // 2. Copy it to the clipboard
  try {
    await navigator.clipboard.writeText(fullUrl);
    showToast('Shareable link copied to clipboard!');
  } catch (err) {
    showToast('Failed to copy link.');
    window.prompt('Copy this link:', fullUrl);
  }
}

// Share button
shareBtn.addEventListener('click', async () => {
  await shareAnalysis(currentLoadedJobId);
});

// ===== History (server) =====
async function loadHistory() {
  const resp = await fetch('/api/history');
  if (!resp.ok) return [];
  return await resp.json();
}

async function renderHistory() {
  if (!historyList) return;
  historyList.innerHTML = '';
  const history = await loadHistory();

  if (!history || history.length === 0) {
    historyList.innerHTML = `<li class="muted tiny" style="padding: 10px 12px;">No history yet.</li>`;
    await updateHistoryStorageUI();
    return;
  }

  // Get current active item ID from localStorage or URL
  const currentItemId = localStorage.getItem('currentHistoryItemId');
  const searchQuery = historySearchInput?.value?.toLowerCase() || '';
  let filteredHistory = history;

  // Filter by search query
  if (searchQuery) {
    filteredHistory = history.filter(item => 
      item.name.toLowerCase().includes(searchQuery)
    );
  }

  if (filteredHistory.length === 0) {
    historyList.innerHTML = `<li class="muted tiny" style="padding: 10px 12px; text-align: center;">No results found.</li>`;
    await updateHistoryStorageUI();
    return;
  }

  for (const item of filteredHistory) {
    const li = document.createElement('li');
    li.className = 'history-item';
    if (item.id === currentItemId) {
      li.classList.add('active');
    }
    li.dataset.id = item.id;

    const timeAgoStr = timeAgo(item.createdAt || item.id);

    // New layout: name on left, timestamp on right (ESCAPED to prevent XSS)
    const safeName = escapeHTML(String(item.name || 'Untitled').slice(0, 200));
    li.innerHTML = `
      <span class="history-name" title="${safeName}">${safeName}</span>
      <span class="history-timestamp">${timeAgoStr}</span>
      <div class="history-menu">
        <button class="history-menu-toggle">⋮</button>
        <div class="history-menu-dropdown hidden">
          <button class="history-menu-item" data-action="rename"><span>✏️</span> Rename</button>
          <button class="history-menu-item" data-action="share"><span>🔗</span> Share</button>
          <button class="history-menu-item history-menu-delete" data-action="delete"><span>🗑️</span> Delete</button>
        </div>
      </div>
    `;
    historyList.appendChild(li);
  }
  await updateHistoryStorageUI();
}


function timeAgo(date) {
  const now = new Date();
  const then = new Date(date);
  const diffMs = now - then;
  const diffSecs = Math.floor(diffMs / 1000);
  const diffMins = Math.floor(diffSecs / 60);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);
  const diffWeeks = Math.floor(diffDays / 7);
  const diffMonths = Math.floor(diffDays / 30);
  const diffYears = Math.floor(diffDays / 365);

  if (diffSecs < 60) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  if (diffWeeks < 4) return `${diffWeeks}w ago`;
  if (diffMonths < 12) return `${diffMonths}mo ago`;
  return `${diffYears}y ago`;
}

function bytesToHuman(bytes) {
  const gb = bytes / (1024 * 1024 * 1024);
  if (gb >= 1) return `${gb.toFixed(2)} GB`;
  const mb = bytes / (1024 * 1024);
  if (mb >= 1) return `${mb.toFixed(1)} MB`;
  const kb = bytes / 1024;
  if (kb >= 1) return `${kb.toFixed(0)} KB`;
  return `${bytes} B`;
}

function estimateItemSizeBytes(item) {
  let total = 0;
  try { total += new Blob([item.analysisText || '']).size; } catch {}
  if (item.videoData instanceof Blob) {
    total += item.videoData.size || 0;
  } else if (typeof item.videoData === 'string') {
    try { total += new Blob([item.videoData]).size; } catch {}
  }
  return total;
}

async function updateHistoryStorageUI() {
  if (!historyStorageBar || !historyStorageText) return;
  try {
    const r = await fetch('/api/history/storage');
    if (!r.ok) throw new Error();
    const { used, total } = await r.json();
    const pct = Math.max(0, Math.min(100, (used / (total || TOTAL_STORAGE_BYTES)) * 100));
    historyStorageBar.style.width = `${pct}%`;
    historyStorageText.textContent = `${bytesToHuman(used)} / 20 GB`;
  } catch {
    historyStorageBar.style.width = '0%';
    historyStorageText.textContent = `— / 20 GB`;
  }
}

// Close all dropdown menus
function closeAllHistoryMenus() {
  document.querySelectorAll('.history-menu-dropdown').forEach(menu => {
    menu.classList.add('hidden');
  });
}

// Close menus when clicking outside
document.addEventListener('click', (e) => {
  if (!e.target.closest('.history-menu')) {
    closeAllHistoryMenus();
  }
});

historyList?.addEventListener('click', async (e) => {
  // Handle menu toggle button
  if (e.target.classList.contains('history-menu-toggle')) {
    e.stopPropagation();
    const dropdown = e.target.nextElementSibling;
    const isHidden = dropdown.classList.contains('hidden');
    
    // Close all other menus
    closeAllHistoryMenus();
    
    // Toggle this menu
    if (isHidden) {
      dropdown.classList.remove('hidden');
    }
    return;
  }

  // Handle menu item clicks
  const menuItem = e.target.closest('.history-menu-item');
  if (menuItem) {
    e.stopPropagation();
  const itemEl = e.target.closest('.history-item');
  if (!itemEl) return;
    
  const id = itemEl.dataset.id;
    const action = menuItem.dataset.action;
    
    // Close the dropdown
    closeAllHistoryMenus();

  const hist = await loadHistory();
  const item = hist.find(i => String(i.id) === String(id));
  if (!item) return;

    if (action === 'delete') {
      if (confirm(`Delete "${item.name}"?\n\nThis will permanently delete:\n- The analysis data\n- The video file\n- All associated files\n\nThis action cannot be undone.`)) {
        await showDeleteProgress(item.name, async () => {
          const res = await fetch(`/api/history/${id}`, { method: 'DELETE' });
          if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.message || 'Failed to delete');
          }
        });
        
        showToast('Deleted successfully');
        await renderHistory();
      }
    } else if (action === 'rename') {
      const newName = prompt('Enter new name:', item.name);
      if (newName && newName.trim()) {
        try {
          const res = await fetch(`/api/history/${id}`, { 
            method: 'PUT', 
            headers: { 'Content-Type':'application/json' }, 
            body: JSON.stringify({ name: newName.trim() }) 
          });
          if (res.ok) {
        await renderHistory();
            showToast('Renamed successfully');
      } else {
            showToast('Failed to rename');
          }
        } catch (err) {
          showToast('Failed to rename. Please try again.');
        }
      }
    } else if (action === 'share') {
      shareAnalysis(item.id); // Call with just the ID
    }
    return;
  }

  // Load item when clicking on the item itself (not menu)
  const itemEl = e.target.closest('.history-item');
  if (!itemEl || e.target.closest('.history-menu')) return;
  
  const id = itemEl.dataset.id;
  const hist = await loadHistory();
  const item = hist.find(i => String(i.id) === String(id));
  if (!item) return;

  // Set active state
  localStorage.setItem('currentHistoryItemId', id);
  
  // Load item:
  loadJobIntoUI(item);
  
  // Re-render to update active states
  await renderHistory();
});

// Search input event listener
historySearchInput?.addEventListener('input', async () => {
  await renderHistory();
});

document.addEventListener('DOMContentLoaded', async () => {
  await renderHistory();
});
