import * as path from "path";
import * as os from "os";
export const WINDSURF_AUTH_PROVIDER_ID = 'windsurf_auth';
export const WINDSURF_CALLBACK_URI_BASE = 'windsurf://codeium.windsurf';
export const FIREBASE_API_KEY = 'AIzaSyDsOl-1XpT5err0Tcnx8FFod1H8gVGIycY';
export const FIREBASE_LOGIN_URL = `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${FIREBASE_API_KEY}`;
export const FIREBASE_REFRESH_URL = `https://securetoken.googleapis.com/v1/token?key=${FIREBASE_API_KEY}`;
export const WINDSURF_PLAN_URL = 'https://web-backend.windsurf.com/exa.seat_management_pb.SeatManagementService/GetPlanStatus';
export const WINDSURF_ORIGIN = 'https://windsurf.com';
export const FIREBASE_REFERER = `${WINDSURF_ORIGIN}/`;
// Auth1 (fallback for accounts that Firebase signInWithPassword now refuses).
// Mirrors Services/WindsurfApiService.cs Auth1LoginAsync flow:
//   1) POST /_devin-auth/password/login  -> { token: auth1Token }
//   2) POST /_backend/.../WindsurfPostAuth { auth1Token, orgId:"" } -> { sessionToken, ... }
export const AUTH1_PASSWORD_LOGIN_URL = `${WINDSURF_ORIGIN}/_devin-auth/password/login`;
export const WINDSURF_POST_AUTH_URL = `${WINDSURF_ORIGIN}/_backend/exa.seat_management_pb.SeatManagementService/WindsurfPostAuth`;
export const WINDSURF_EDITOR_SIGNIN_REFERER = `${WINDSURF_ORIGIN}/editor/signin`;
/** Auth1 sessionToken is valid for 14 days (matches desktop). */
export const AUTH1_EXPIRES_IN_SECONDS = 14 * 24 * 60 * 60;
export const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
export const MANAGER_DATA_DIR_NAME = 'windsurf-manager-desktop';
export const ACCOUNTS_FILE_NAME = 'accounts.json';
export const TOKEN_CACHE_STATE_KEY = 'windsurfSwitch.tokenCache';
export const TOKEN_SKEW_MS = 60 * 1000;
export const URI_FIRE_DELAY_MS = 500;
export const FIREBASE_PROVIDER = 'firebase';
export const AUTH1_PROVIDER = 'auth1';
export function getAccountsDir() {
    if (process.platform === 'win32') {
        const appData = process.env.APPDATA || path.join(process.env.USERPROFILE || os.homedir(), 'AppData', 'Roaming');
        return path.join(appData, MANAGER_DATA_DIR_NAME);
    }
    if (process.platform === 'darwin') {
        return path.join(os.homedir(), 'Library', 'Application Support', MANAGER_DATA_DIR_NAME);
    }
    // Linux / other POSIX: respect XDG_CONFIG_HOME, default ~/.config.
    const xdg = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
    return path.join(xdg, MANAGER_DATA_DIR_NAME);
}
export function getAccountsFilePath() {
    return path.join(getAccountsDir(), ACCOUNTS_FILE_NAME);
}