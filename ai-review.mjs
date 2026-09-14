#!/usr/bin/env node
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

// If running locally, load .env file
const envPath = path.resolve(process.cwd(), '.env');
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf8');
  envContent.split('\n').forEach(line => {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
      const parts = trimmed.split('=');
      const key = parts[0].trim();
      const value = parts.slice(1).join('=').trim().replace(/^['"]|['"]$/g, '');
      if (key && !process.env[key]) {
        process.env[key] = value;
      }
    }
  });
}

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const MODEL = process.env.OPENROUTER_MODEL || 'deepseek/deepseek-chat';

if (!OPENROUTER_API_KEY) {
  console.warn('⚠️ [AI Reviewer] OPENROUTER_API_KEY is not set. Skipping AI review.');
  process.exit(0);
}

try {
  // Determine if base ref is passed (e.g. for CI environment: node ai-review.js origin/main)
  const args = process.argv.slice(2);
  let gitCmd = 'git diff --cached --unified=3';

  if (args.length > 0) {
    const baseRef = args[0];
    console.log(`🤖 AI Reviewer: Comparing changes against base ref: ${baseRef}`);
    gitCmd = `git diff ${baseRef}...HEAD --unified=3`;
  } else {
    console.log('🤖 AI Reviewer: Reviewing staged changes (pre-commit)...');
  }

  // Get diff
  let diff = '';
  try {
    diff = execSync(gitCmd).toString();
  } catch (err) {
    console.error(`⚠️ Failed to run git diff command: ${gitCmd}`);
    console.error(err.message);
    process.exit(0); // Soft fail: don't block the developer/CI if git command fails unexpectedly
  }

  if (!diff.trim()) {
    console.log('✅ No code changes to review.');
    process.exit(0);
  }

  // Filter out lockfiles, asset binaries, svgs, and other noise to save tokens and avoid false positives
  const filteredLines = diff.split('\n').filter(line => {
    return !line.match(/package-lock\.json|pnpm-lock\.yaml|composer\.lock|\.svg|fonts|images/);
  });
  const cleanedDiff = filteredLines.join('\n');

  if (!cleanedDiff.trim()) {
    console.log('✅ Staged changes contain only lockfiles or static assets. Skipping review.');
    process.exit(0);
  }

  // Token guard: limit diff size to around 30,000 characters to prevent excessive API costs
  if (cleanedDiff.length > 40000) {
    console.warn('⚠️ Diff size is very large. Sending truncated diff to AI review.');
  }
  const diffToSend = cleanedDiff.slice(0, 40000);

  console.log(`🤖 Requesting code review from OpenRouter (${MODEL})...`);

  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
      'HTTP-Referer': 'https://nestlingnotes.com',
      'X-Title': 'Nestling Notes Agent Reviewer',
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        {
          role: 'system',
          content: `You are an automated senior security engineer and code reviewer.
Analyze the git diff for critical security vulnerabilities (SQL injection, XSS, CSRF, insecure authentication, credential leaks, bad practices) or logic flaws.

Formatting instructions:
- If you find a critical issue that SHOULD block the commit/PR, start your response with "VIOLATIONS_FOUND:" followed by bullet points explaining the issues.
- If the code is secure and clean, respond ONLY with "ALL_CLEAR".
- Be brief and direct.`
        },
        {
          role: 'user',
          content: diffToSend
        }
      ]
    })
  });

  if (!response.ok) {
    throw new Error(`OpenRouter returned status ${response.status}: ${response.statusText}`);
  }

  const data = await response.json();
  const reviewText = data.choices?.[0]?.message?.content || '';

  if (reviewText.startsWith('VIOLATIONS_FOUND:')) {
    console.error('\n❌ [AI Reviewer] Critical violations found:');
    console.error(reviewText.replace('VIOLATIONS_FOUND:', '').trim());
    console.error('\nPlease fix these issues before committing, or bypass with `git commit --no-verify` if they are false positives.\n');
    process.exit(1);
  }

  console.log('✅ [AI Reviewer] Code check passed successfully.');
  process.exit(0);
} catch (error) {
  console.error('⚠️ [AI Reviewer] Failed to execute scan:', error.message);
  process.exit(0); // Soft fail to not block developers if OpenRouter/network is down
}