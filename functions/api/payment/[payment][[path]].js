// functions/api/payment/[[path]].js
// /api/payment/* 경로를 payment.js로 위임
import { onRequestGet, onRequestPost, onRequestOptions } from "../payment.js";
export { onRequestGet, onRequestPost, onRequestOptions };
