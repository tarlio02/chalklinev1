/**
 * Generates one mp3 per Chalkline tour step from the exact narration text
 * already in the tour script (STEPS[].body in index.html).
 *
 * Run locally (not in the browser, not through the Worker):
 *   export OPENAI_API_KEY=sk-...
 *   node generate-tour-audio.js
 *
 * Needs Node 18+ (built-in fetch). Output goes to ./assets/tour-audio/<id>.mp3 —
 * copy that folder into your GitHub Pages repo at assets/tour-audio/.
 *
 * To use ElevenLabs instead, swap the fetch call in synth() for:
 *   POST https://api.elevenlabs.io/v1/text-to-speech/<voice_id>
 *   headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY, 'Content-Type':'application/json' }
 *   body: { text, model_id:'eleven_turbo_v2_5' }
 */

const fs = require('fs');
const path = require('path');

const OUT_DIR = path.join(__dirname, 'assets', 'tour-audio');
const VOICE = 'nova'; // warm, friendly — matches the tutor's spoken-lecture tone
const MODEL = 'tts-1'; // swap to 'tts-1-hd' or 'gpt-4o-mini-tts' for higher quality / higher cost

// id -> narration text, copied verbatim from STEPS[].body in index.html.
const STEPS = [
  ['welcome', 'Your AI study companion. This quick tour shows you how everything works, starting with adding your first course.'],
  ['add-course', 'A course is a folder for one subject, like STA2020 or Managerial Accounting. Your lessons, quizzes, summaries and notes all live inside it. Tap Add new course.'],
  ['name-course', 'Type the subject you are studying, for example "STA2020", then tap Create course.'],
  ['course-intro', 'Everything for this subject lives here. Let me show you what each button does.'],
  ['card-tutor', 'Your AI teacher. Ask about any topic and it teaches on a whiteboard while it talks. Your past lessons are saved here too.'],
  ['card-quiz', 'Test yourself on what you have learned. Your previous quizzes show up here, and you can start a new one any time.'],
  ['card-summary', 'Import a chapter or slide deck, a PDF, and get a clean summary to revise from.'],
  ['card-notes', 'Write your own notes and keep them filed under this course.'],
  ['go-tutor', 'Tap Live tutor to open your lessons.'],
  ['history-list', 'Every lesson you finish is saved in this list, so you can reopen it and pick up exactly where you left off. It is empty for now.'],
  ['history-start', 'Tap Start new lesson.'],
  ['canvas-topic', 'Type a topic, for example "ANOVA", then press Start lesson. Your tutor will begin teaching straight away.'],
  ['canvas-board', 'Your tutor draws and writes here while it explains. You can watch, and the tutor also narrates out loud.'],
  ['canvas-ask', 'Type a follow-up question here. Use the microphone to speak to your tutor, or the paperclip to attach a photo, PDF or text file for it to teach from.'],
  ['canvas-replay', 'Missed something? Replay the tutor\u2019s last explanation.'],
  ['canvas-transcript', 'Read back everything that has been said in this lesson.'],
  ['canvas-menu', 'Open this for lesson tools such as Export PDF, board backgrounds and the Chalkline assistant.'],
  ['canvas-exit', 'When you are done, tap Exit Lesson. Your progress saves automatically. Go ahead and exit now to finish your first lesson.'],
  ['after-quiz', 'Now that you have learned something, use Quizzes to check it stuck. During lessons the tutor also pops up quick questions. If you are stuck, tap "I\u2019m not sure yet".'],
  ['after-summary', 'Got lecture slides or a textbook chapter? Import the PDF here for a clean summary.'],
  ['after-notes', 'Jot down anything worth remembering. Notes stay attached to this course.'],
  ['after-assistant', 'For quick questions and study help, tap "Chalkline assistant" in the sidebar. On a phone, open the sidebar first. It is available on every page.'],
  ['finish', 'That is the whole tour. You can replay it any time from Settings, Getting-started guide.'],
];

async function synth(text) {
  const res = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model: MODEL, voice: VOICE, input: text, response_format: 'mp3' }),
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${await res.text()}`);
  return Buffer.from(await res.arrayBuffer());
}

async function main() {
  if (!process.env.OPENAI_API_KEY) {
    console.error('Set OPENAI_API_KEY first: export OPENAI_API_KEY=sk-...');
    process.exit(1);
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });

  for (const [id, text] of STEPS) {
    const outFile = path.join(OUT_DIR, `${id}.mp3`);
    if (fs.existsSync(outFile)) {
      console.log(`skip  ${id} (already exists)`);
      continue;
    }
    process.stdout.write(`synth ${id} ... `);
    try {
      const audio = await synth(text);
      fs.writeFileSync(outFile, audio);
      console.log(`ok (${(audio.length / 1024).toFixed(0)} KB)`);
    } catch (err) {
      console.log('FAILED');
      console.error(`  ${id}: ${err.message}`);
    }
  }
  console.log(`\nDone. Copy ${OUT_DIR} into your repo at assets/tour-audio/`);
}

main();
