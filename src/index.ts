import { serve } from "@hono/node-server";
import dotenv from "dotenv";
import app from "./app.js";

dotenv.config();

const port = Number(process.env.PORT) || 3000;

console.log(`🚀 Video Translator API (Production) starting on port ${port}...`);
console.log(`📝 Features:`);
console.log(`   - File upload with multipart/form-data`);
console.log(`   - Async job processing`);
console.log(`   - Job status polling`);
console.log(`   - Preview generation`);
console.log(`   - File download`);
console.log("");

serve(
  {
    fetch: app.fetch,
    port,
  },
  (info) => {
    console.log(`✅ Production API running at http://localhost:${info.port}`);
    console.log(`📖 API Documentation: http://localhost:${info.port}/`);
    console.log("");
  }
);
