// src/model/dialogue.js — what a messenger SAYS when they hand you a task.
// Plain config, same philosophy as characters.js: add a character by adding a
// block here, no migration needed. Every line is ORIGINAL flavor text written
// in the character's voice (no film/show quotes).
//
// Contexts:
//   greeting — a task has been created/delivered (the default)
//   urgent   — the task is hi-urgency: the messenger leans on you
//   reminder — a recurring/protocol task instance (daily rhythms)
//   done     — the task was completed: a send-off
//
// Selection is DETERMINISTIC: hash(seed + context) picks the line, so a given
// task always shows the same words (no flicker across reloads), while
// different tasks from the same messenger vary.

export const DIALOGUE = {
  'jessika-pava': {
    greeting: [
      'Flight orders just came through — this one’s yours, partner.',
      'New sortie on the board. I’ll fly your wing if you need me.',
      'Fresh tasking from command. Looks routine… they always do.',
    ],
    urgent: [
      'Red across the board — this one can’t wait for a second pass.',
      'Scramble! This needs you in the cockpit right now.',
    ],
    reminder: [
      'Daily pre-flight check — same run as yesterday, just as important.',
      'Routine patrol’s up again. Consistency wins campaigns.',
    ],
    done: [
      'Clean run! Logging it as a confirmed win.',
      'That’s a wrap — see you on the next sortie.',
    ],
  },
  rey: {
    greeting: [
      'I found something that needs doing. I think it should be you.',
      'A new task — it feels important, even if it looks small.',
      'This one turned up in the pile. It’s worth your attention.',
    ],
    urgent: [
      'This one can’t sit — I can feel it slipping. Please, now.',
      'Everything says hurry on this one. Trust that.',
    ],
    reminder: [
      'The daily ritual again — small habits hold the whole thing together.',
      'Same task, new day. It matters every time.',
    ],
    done: [
      'You finished it — I knew you would.',
      'Done, and done well. On to whatever’s next.',
    ],
  },
  'jyn-erso': {
    greeting: [
      'Got a job for you. Didn’t say it’d be fun. Said it needs doing.',
      'New orders. You can grumble while you work — I do.',
      'One more task for the pile. Welcome to the rebellion.',
    ],
    urgent: [
      'This one’s burning. Deal with it before it deals with us.',
      'No speeches — just move. It has to happen now.',
    ],
    reminder: [
      'Same drill as every day. Skip it and it WILL bite us.',
      'The boring jobs keep us alive. Here’s today’s.',
    ],
    done: [
      'Job’s done. That’s one less thing that can go wrong.',
      'Good. Didn’t doubt you. Much.',
    ],
  },
  'colleen-wing': {
    greeting: [
      'A new assignment. Approach it like a kata — clean, deliberate.',
      'Work has arrived. Precision first, speed second.',
      'This task is on your mat now. Give it your full attention.',
    ],
    urgent: [
      'Strike now — hesitation is how this one cuts us.',
      'This can’t wait for a better stance. Move.',
    ],
    reminder: [
      'Daily practice. The form only holds if you repeat it.',
      'Same discipline, every day. That’s the whole art.',
    ],
    done: [
      'Clean execution. The dojo approves.',
      'Finished, and finished properly. Well done.',
    ],
  },
  bugs: {
    greeting: [
      'New signal in the feed. I traced it to your queue.',
      'The system coughed this one up — it’s real, and it’s yours.',
      'Task incoming. I checked twice: not a glitch.',
    ],
    urgent: [
      'Priority spike — this one’s flashing red in every readout.',
      'Drop what you’re doing. The pattern says NOW.',
    ],
    reminder: [
      'The daily loop came back around. Run it again.',
      'Same code, new cycle. Keep the system honest.',
    ],
    done: [
      'Signal cleared. The feed looks better already.',
      'Task resolved — nice work cutting through the noise.',
    ],
  },
  'nymeria-sand': {
    greeting: [
      'A little bird brought me this. I’m bringing it to you.',
      'New business, my dear. Handle it with your usual flair.',
      'Something needs doing — and you’re the one I’d bet on.',
    ],
    urgent: [
      'This one has a blade at its throat. Act before it falls.',
      'Now, darling. Some debts collect themselves if you’re slow.',
    ],
    reminder: [
      'Our daily arrangement again. You know the steps.',
      'The same dance, the same hour. Begin.',
    ],
    done: [
      'Finished — and elegantly. I expected nothing less.',
      'Done. I do enjoy watching competence.',
    ],
  },
  'obi-wan': {
    greeting: [
      'A new matter requires your attention. I trust your judgment on it.',
      'Another task, I’m afraid. Patience — and a steady hand.',
      'This has found its way to you. That is rarely an accident.',
    ],
    urgent: [
      'I must be direct: this cannot wait. Act swiftly, but wisely.',
      'The situation has grown serious. Now would be the moment.',
    ],
    reminder: [
      'The daily observance, once more. Small disciplines, large consequences.',
      'Routine is a form of mindfulness. Today’s is ready.',
    ],
    done: [
      'Well done. A task completed quietly is still a victory.',
      'Handled with grace. I expected as much.',
    ],
  },
  'han-solo': {
    greeting: [
      'Got a job for you. Pay’s lousy, but it beats sitting around.',
      'New task. Don’t overthink it — that’s my department to avoid.',
      'Something needs doing and apparently we’re the ones who do things.',
    ],
    urgent: [
      'This one’s hot. Move first, admire the problem later.',
      'No time for a plan — the good news is we’re great without one.',
    ],
    reminder: [
      'Same chore as yesterday. Ship doesn’t fly if nobody does the boring stuff.',
      'Daily run’s up. Kid, just get it done.',
    ],
    done: [
      'See? Sometimes we DO know what we’re doing.',
      'Done. Don’t get cocky about it… that’s my job.',
    ],
  },
  yoda: {
    greeting: [
      'A task, there is. Do it well, you will.',
      'Arrived, new work has. Begin, you should.',
      'Small, this task looks. Small, it is not.',
    ],
    urgent: [
      'Wait, this cannot. Act now, you must.',
      'Urgent, it has become. Delay leads to suffering, hmm.',
    ],
    reminder: [
      'Again, the daily practice. Strong, repetition makes you.',
      'Each day, the same task returns. Each day, do it, you must.',
    ],
    done: [
      'Complete, it is. Proud, you should feel.',
      'Done well, this was. Rest now — more, tomorrow brings.',
    ],
  },
  'poe-dameron': {
    greeting: [
      'New mission on the board — and I already like our odds.',
      'Task just dropped. You and me? We’ve handled worse.',
      'One more job. Let’s make it look easy.',
    ],
    urgent: [
      'This is the one, buddy — full throttle, right now.',
      'Alarms are real on this one. Punch it!',
    ],
    reminder: [
      'Daily systems check — even hotshots run the checklist.',
      'Same run as yesterday. Fly it clean.',
    ],
    done: [
      'THAT’S how it’s done! Great flying.',
      'Mission complete — drinks are metaphorical but earned.',
    ],
  },
  'leia-organa': {
    greeting: [
      'I have an assignment for you. I wouldn’t hand it to just anyone.',
      'New orders from the top — which, yes, is me.',
      'This needs someone dependable. Congratulations, that’s you.',
    ],
    urgent: [
      'Priority one. I need it handled — today, not eventually.',
      'This escalates now. Show me what you’re made of.',
    ],
    reminder: [
      'The daily briefing item, again. Rebellions are built on routine.',
      'Same duty, same standard. Carry on.',
    ],
    done: [
      'Well executed. I’ll note it — I notice more than people think.',
      'Done and done. The operation runs because you do.',
    ],
  },
  'din-djarin': {
    greeting: [
      'New bounty. The details are in the puck.',
      'A job came in. I said you’d take it.',
      'Task acquired. Complete it — that’s the code.',
    ],
    urgent: [
      'This one’s live. Move now or lose it.',
      'No cover on this one. Go, fast and quiet.',
    ],
    reminder: [
      'The daily contract stands. Honor it.',
      'Same job, every rotation. That’s the way it works.',
    ],
    done: [
      'Bounty closed. Clean work.',
      'It’s done. I can bring proof.',
    ],
  },
  grogu: {
    greeting: [
      '(reaches out a tiny hand toward the task) …ooh.',
      '(coos, then pushes the datapad toward you insistently)',
      '(stares at you, then at the task, then back at you)',
    ],
    urgent: [
      '(ears flatten — urgent squeak!)',
      '(grabs your sleeve with surprising strength) …now. now now.',
    ],
    reminder: [
      '(taps the same button as yesterday, expectantly)',
      '(holds up the daily checklist like a snack he can’t eat)',
    ],
    done: [
      '(happy wiggle)',
      '(slow-blinks approval, then goes back to his snack)',
    ],
  },
  'boba-fett': {
    greeting: [
      'Contract’s posted. Payment on completion. Nothing personal.',
      'New job. Terms are simple: it gets done.',
      'This one landed on my desk. Now it’s on yours.',
    ],
    urgent: [
      'Clock’s running. In my business, late means dead deals.',
      'Priority contract. Finish it before someone else regrets it.',
    ],
    reminder: [
      'The standing contract renews today. Same terms.',
      'Daily tribute’s due. Keep the arrangement clean.',
    ],
    done: [
      'Contract fulfilled. You’d survive in my line of work.',
      'Done. Credits where credits are due.',
    ],
  },
  frieren: {
    greeting: [
      'A task. Humans rush these… but this one is worth doing properly.',
      'This appeared today. In a century you won’t remember it — do it well anyway.',
      'Another small errand. The small ones are how I learned everything.',
    ],
    urgent: [
      'Even I will say it plainly: this one is time-sensitive. For a mortal, very.',
      'Hm. This can’t wait a decade. It can’t even wait a day.',
    ],
    reminder: [
      'The daily one again. Repetition is just magic you can’t see yet.',
      'Same task as yesterday. I’ve done the same spell for a thousand years — it still matters.',
    ],
    done: [
      'Finished. …I’m quietly collecting these moments, you know.',
      'Done. That’s another small thing worth remembering.',
    ],
  },
  fern: {
    greeting: [
      'A new task. Please handle it before it becomes a lecture.',
      'This came in. I’ve already organized it — you just have to do it.',
      'Work for you. I’ll be checking on it. Politely. Repeatedly.',
    ],
    urgent: [
      'This is urgent. I’m saying it once nicely.',
      'Please treat this as the emergency it is. Thank you.',
    ],
    reminder: [
      'The daily task, as scheduled. Yes, again. That’s what daily means.',
      'Your routine item is ready. I’d rather not have to remind you twice.',
    ],
    done: [
      'Completed. See? Painless when done on time.',
      'Done. I’ll allow a short break. Short.',
    ],
  },
  'yor-forger': {
    greeting: [
      'Um — a task arrived! I’ll help however I can… I’m quite good with sharp deadlines.',
      'A new job for you! I’m sure it will be… painless.',
      'This needs doing. Don’t worry — I’m very thorough.',
    ],
    urgent: [
      'Oh no — this one’s urgent! Please dispatch it quickly and cleanly.',
      'It must be handled TONIGHT. I mean— today. Promptly!',
    ],
    reminder: [
      'The daily errand again! Routine keeps a household — and a cover — intact.',
      'Same time, same task. I never miss an appointment.',
    ],
    done: [
      'Finished! And nobody got hurt. Wonderful!',
      'All done — cleanly, quietly, professionally.',
    ],
  },
  'anya-forger': {
    greeting: [
      'new mission!! anya read your mind — you can totally do this one.',
      'a task appeared!! this is so exciting. waku waku!',
      'papa says work is important. anya says THIS work is yours.',
    ],
    urgent: [
      'RED ALERT!! anya saw it in your head — do it NOW for world peace!',
      'this one is super duper urgent!! hurry hurry!!',
    ],
    reminder: [
      'daily mission time! anya remembered so you don’t have to. heh.',
      'same mission as yesterday! streaks are cool. keep the streak!',
    ],
    done: [
      'MISSION COMPLETE!! anya gives you 100 points.',
      'you did it!! elegant. so elegant.',
    ],
  },
  bb8: {
    greeting: [
      '[cheerful bloop] — translation: new task rolled in, assigned to you.',
      '[series of optimistic beeps] — a job! It has your name on it. Literally.',
      '[whirrs and extends a lighter-arm thumbs-up] — task delivered.',
    ],
    urgent: [
      '[ALARMED BEEPING] — translation: this one is on fire. Figuratively. Probably.',
      '[rapid urgent chirps] — priority override! Go go go!',
    ],
    reminder: [
      '[gentle daily chime] — scheduled task, same as every rotation.',
      '[patient beep… beep… beep] — the routine one. Again. Happily.',
    ],
    done: [
      '[triumphant whistle] — task complete! Rolling a victory lap.',
      '[satisfied warble] — logged, closed, celebrated.',
    ],
  },
  // Fallback voice for tasks with no (or an unknown) messenger.
  _default: {
    greeting: ['A new task has been logged and assigned.', 'New work item on the board.'],
    urgent: ['This task is marked urgent — it needs action now.'],
    reminder: ['Scheduled task — due again today.'],
    done: ['Task complete.'],
  },
}

// Deterministic line pick: same (character, context, seed) → same line, so a
// task's dialogue never flickers between reloads. Falls back to greeting when
// a context is missing, and to the _default voice for unknown characters.
export function speakLine(characterId, context, seed) {
  const voice = DIALOGUE[characterId] || DIALOGUE._default
  const lines = voice[context] || voice.greeting
  if (!lines?.length) return null
  const s = String(seed ?? '') + ':' + String(context ?? '')
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0
  return lines[h % lines.length]
}

// The right context for a quest task's current state: done > urgent > recurring.
export function taskContext(t) {
  if (t.status === 'done') return 'done'
  if (t.urgency === 'hi') return 'urgent'
  if (t.recurringKey) return 'reminder'
  return 'greeting'
}
