#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const [,, cmd, ...rest] = process.argv
const url = process.env.AIRI_WS_URL || 'ws://127.0.0.1:6121/ws'
const target = process.env.OPENCLAW_TO || '+16473668191'
const openclawBin = process.env.OPENCLAW_BIN || 'openclaw'
const timeoutSec = process.env.OPENCLAW_TIMEOUT || '120'
const localAudioBase = process.env.AIRI_LOCAL_AUDIO_BASE || 'http://127.0.0.1:4319'
const speakReplies = process.env.AIRI_BRIDGE_SPEAK !== '0'

function usage() {
  console.log(`Usage:
  node examples/openclaw-bridge.mjs send "Hello from OpenClaw"
  node examples/openclaw-bridge.mjs listen
  node examples/openclaw-bridge.mjs loop

Env:
  AIRI_WS_URL=ws://127.0.0.1:6121/ws
  OPENCLAW_TO=+16473668191
  OPENCLAW_BIN=openclaw
  OPENCLAW_TIMEOUT=120`)
}

function unwrapWireMessage(raw) {
  try {
    const parsed = JSON.parse(String(raw))
    if (parsed && typeof parsed === 'object' && parsed.json)
      return parsed.json
    return parsed
  }
  catch {
    return null
  }
}

function assistantEvent(text, inputData = {}) {
  const message = {
    role: 'assistant',
    content: text,
    slices: [{ type: 'text', text }],
    tool_results: [],
  }
  const genAiContext = {
    message: { role: 'user', content: inputData.text || '' },
    composedMessage: [{ role: 'user', content: inputData.text || '' }],
    contexts: {},
    input: { type: 'input:text', data: inputData },
  }
  return [
    {
      type: 'output:gen-ai:chat:message',
      data: {
        ...inputData,
        message,
        'stage-tamagotchi': true,
        'gen-ai:chat': genAiContext,
      },
    },
    {
      type: 'output:gen-ai:chat:complete',
      data: {
        ...inputData,
        message,
        toolCalls: [],
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, source: 'estimate-based' },
        'stage-tamagotchi': true,
        'gen-ai:chat': genAiContext,
      },
    },
  ]
}

function callOpenClaw(message) {
  return new Promise((resolve, reject) => {
    const child = spawn(openclawBin, ['agent', '--to', target, '--message', message, '--json', '--timeout', timeoutSec], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', d => stdout += d.toString())
    child.stderr.on('data', d => stderr += d.toString())
    child.on('error', reject)
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(stderr || stdout || `openclaw exited ${code}`))
        return
      }
      try {
        const data = JSON.parse(stdout)
        const text = data?.result?.payloads?.[0]?.text || data?.payloads?.[0]?.text || ''
        resolve(String(text).trim())
      }
      catch (err) {
        reject(new Error(`Failed to parse OpenClaw output: ${err.message}\n${stdout}`))
      }
    })
  })
}

async function speakText(text) {
  if (!speakReplies || !text?.trim())
    return

  const form = new FormData()
  form.set('model', 'kitten-1')
  form.set('voice', process.env.KITTEN_VOICE || 'Rosie')
  form.set('input', text)

  const res = await fetch(`${localAudioBase}/v1/audio/speech`, { method: 'POST', body: form })
  if (!res.ok)
    throw new Error(`local audio server failed: ${res.status} ${await res.text()}`)

  const audio = Buffer.from(await res.arrayBuffer())
  const dir = mkdtempSync(join(tmpdir(), 'airi-bridge-'))
  const out = join(dir, 'reply.wav')
  await import('node:fs/promises').then(fs => fs.writeFile(out, audio))

  await new Promise((resolve, reject) => {
    const player = spawn('afplay', [out], { stdio: 'ignore' })
    player.on('error', reject)
    player.on('close', code => code === 0 ? resolve() : reject(new Error(`afplay exited ${code}`)))
  })
}

if (!cmd || ['-h', '--help', 'help'].includes(cmd)) {
  usage()
  process.exit(0)
}

const ws = new WebSocket(url)
let sent = false
let pending = false
let lastUserText = null

ws.addEventListener('open', async () => {
  if (cmd === 'send') {
    const text = rest.join(' ').trim()
    if (!text) {
      console.error('No text provided.')
      process.exit(1)
    }
    ws.send(JSON.stringify({ type: 'input:text', data: { text } }))
    sent = true
    console.log('sent input:text to AIRI')
    setTimeout(() => ws.close(), 1500)
  }
  else if (cmd === 'listen') {
    console.log(`listening on ${url}`)
  }
  else if (cmd === 'loop') {
    console.log(`looping on ${url} -> OpenClaw target ${target}`)
  }
  else {
    usage()
    process.exit(1)
  }
})

ws.addEventListener('message', async (ev) => {
  const msg = unwrapWireMessage(ev.data)
  if (!msg) {
    console.log(String(ev.data))
    return
  }

  if (cmd === 'listen') {
    console.log(JSON.stringify(msg, null, 2))
    return
  }

  if (cmd !== 'loop') {
    console.log(JSON.stringify(msg, null, 2))
    return
  }

  if (msg.type !== 'input:text')
    return

  const text = msg.data?.text?.trim()
  if (!text)
    return

  if (text === lastUserText && pending)
    return

  // Ignore our own mirrored assistant outputs if some stage loops them back as input.
  if (text.startsWith('[OpenClaw] '))
    return

  lastUserText = text
  pending = true
  console.log(`AIRI -> OpenClaw: ${text}`)

  try {
    const reply = await callOpenClaw(text)
    const normalized = reply || '(no reply)'
    for (const envelope of assistantEvent(normalized, msg.data || { text })) {
      ws.send(JSON.stringify(envelope))
    }
    await speakText(normalized)
    console.log(`OpenClaw -> AIRI: ${normalized.slice(0, 160)}`)
  }
  catch (error) {
    const textErr = `[OpenClaw bridge error] ${error.message}`
    for (const envelope of assistantEvent(textErr, msg.data || { text })) {
      ws.send(JSON.stringify(envelope))
    }
    console.error(textErr)
  }
  finally {
    pending = false
  }
})

ws.addEventListener('close', () => {
  if (cmd === 'send' && sent)
    process.exit(0)
})

ws.addEventListener('error', (err) => {
  console.error('websocket error', err)
  process.exit(1)
})
