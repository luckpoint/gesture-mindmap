// Existing browser service APIs are loaded at this boundary.
import '../i18n.js';
import '../icons/catalog.js';
import '../icons/palette.js';
import '../features.js';
import '../speech/controller.js';
import '../gestures/recognition.js';
import '../gestures/controller.js';
import '../gestures/debug.js';
import '../gestures/camera.js';
import '../images/privacy.js';
import '../images/format.js';
import '../images/store.js';
import '../images/upload.js';
import '../instructions/operations.js';
import '../instructions/client.js';
import '../storage/library.js';
import '../storage/locks.js';
import '../storage/history.js';
import '../print.js';
import { create } from './browser.js';

void create(globalThis).start();
