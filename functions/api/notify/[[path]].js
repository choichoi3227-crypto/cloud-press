// functions/api/notify/[[path]].js
// /api/notify/* 경로를 notify.js로 위임

import {
  onRequestGet,
  onRequestPost,
  onRequestOptions,
} from "../notify.js";

export { onRequestGet, onRequestPost, onRequestOptions };
