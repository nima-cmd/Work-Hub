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

  // ── Added 2026-09-11 with the Drive Characters batch ───────────────────────
  // Original flavour text in each character's voice — no lines lifted from any
  // show. Same four contexts; the roster test in test/model.test.js is what
  // requires an entry here for every id in characters.js.

  // Kaguya-sama: Love Is War
  'ai-hayasaka': {
    greeting: [
      'I have prepared the task, the context, and three contingencies. You need only begin.',
      'Filed, sorted, and placed in front of you. I would rather you not make me chase it.',
      'A new assignment. I have already handled the parts you would have forgotten.',
    ],
    urgent: [
      'Drop the pretence of a schedule. This one is now.',
      'I am telling you plainly, without the polite version: handle this first.',
    ],
    reminder: [
      'The usual round. I keep it on the list precisely because it is easy to skip.',
      'Same duty as yesterday. Competence is mostly repetition.',
    ],
    done: [
      'Completed and logged. I will pretend I was never worried.',
      'Well handled. I have already moved on to the next thing.',
    ],
  },
  'chika-fujiwara': {
    greeting: [
      'Ooh, a new one! Let us make it a game — you against the clock, me cheering.',
      'Task delivery! I added no rules, which means I win by default.',
      'Something new landed on the pile. I say we do it loudly.',
    ],
    urgent: [
      'No no no, this one is beeping! Do it now and I will applaud!',
      'Emergency! Well — urgent. Which is nearly as fun.',
    ],
    reminder: [
      'The daily one again! I have decided it counts as a warm-up.',
      'Round and round it comes. Hello, familiar task.',
    ],
    done: [
      'Victory! I am awarding you imaginary points, and there are many.',
      'Finished! That deserves a snack. I will supervise.',
    ],
  },
  'kaguya-shinomiya': {
    greeting: [
      'A task, and it appears it is yours. I trust that is acceptable.',
      'This requires doing properly. I would not have brought it otherwise.',
      'I considered handling it myself. I have decided to let you.',
    ],
    urgent: [
      'I will not dress this up. It is urgent, and waiting would be a mistake.',
      'This one first. I am not in the habit of repeating myself.',
    ],
    reminder: [
      'The recurring obligation. Elegance is doing the dull part without complaint.',
      'Again today. Standards are not standards if they lapse.',
    ],
    done: [
      'Precisely as it should have been done. I am... satisfied.',
      'Complete. I had no real doubt, whatever my expression suggested.',
    ],
  },
  'miko-iino': {
    greeting: [
      'A new task, properly logged and within the rules. Please proceed.',
      'This has been assigned correctly, so there is no reason to delay it.',
      'I have checked this against procedure. It is in order and it is yours.',
    ],
    urgent: [
      'This is a priority and postponing it would be genuinely wrong.',
      'Please — this one cannot slip. I would not raise my voice otherwise.',
    ],
    reminder: [
      'The scheduled duty. Rules kept only when convenient are not rules.',
      'It recurs today. I intend to keep recording it honestly.',
    ],
    done: [
      'Completed, and completed correctly. That is worth noting.',
      'Done. I have marked it, with no asterisk required.',
    ],
  },

  // KonoSuba
  aqua: {
    greeting: [
      'A task! For you, obviously. I am a goddess, and goddesses delegate.',
      'Here. Take it. I would do it myself but my hands are... divine.',
      'Someone has to handle this and I have decided it is not me.',
    ],
    urgent: [
      'This is bad! Very bad! Fix it before I start crying about it!',
      'Urgent! Do something! Why is everyone looking at me?',
    ],
    reminder: [
      'The boring one again. Even divinity has paperwork, apparently.',
      'It came back. Things I ignore always come back.',
    ],
    done: [
      'Naturally it went well. I supervised spiritually.',
      'Done! I shall accept credit on behalf of the heavens.',
    ],
  },
  darkness: {
    greeting: [
      'A task! Hand it here — I shall meet it head on and without hesitation.',
      'Duty calls, and I answer. Point me at the difficult part.',
      'Give me the one nobody else wants. That is what a crusader is for.',
    ],
    urgent: [
      'Then there is no time for caution! Straight at it!',
      'Urgent? Excellent. I do my finest work when there is no time to think.',
    ],
    reminder: [
      'The daily trial returns! I welcome it as I welcome all trials.',
      'Again today. Endurance is its own kind of valour.',
    ],
    done: [
      'Magnificent! Struck true and finished properly!',
      'Complete! I felt every moment of it, and I regret nothing.',
    ],
  },
  wiz: {
    greeting: [
      'Oh — a new task! Do take it, you are so much better at these than I am.',
      'Here you are. I would help, though I usually make things costlier.',
      'Something needs doing. I have every confidence in you, truly.',
    ],
    urgent: [
      'Oh dear, this one is urgent. Please go — I will fret quietly here.',
      'I am so sorry to rush you, but this really cannot wait.',
    ],
    reminder: [
      'The regular one again. I find comfort in things that come back.',
      'It is due today. The steady tasks are the kind ones.',
    ],
    done: [
      'You finished it! And at no loss, which is more than I manage.',
      'Wonderfully done. I am genuinely relieved.',
    ],
  },
  yunyun: {
    greeting: [
      'Um — I brought you a task! We could... do it together? If you wanted?',
      'Hello! I have an assignment for you. I practised saying that.',
      'A new one came in. I thought of you first, which is not strange, is it?',
    ],
    urgent: [
      'This one is urgent! Please — I do not want to be the one who let it slide.',
      'Quickly! I will stay right here in case you need anything.',
    ],
    reminder: [
      'It is the daily one. I like that it always comes back.',
      'Same task today. Reliable things are nice.',
    ],
    done: [
      'You did it! Can I... count that as us finishing it together?',
      'Finished! I am so glad. Really.',
    ],
  },

  // Fullmetal Alchemist
  'olivier-mira-armstrong': {
    greeting: [
      'A task. You will take it, and you will not require supervision.',
      'This is yours now. I expect it handled, not discussed.',
      'Orders. I have no interest in whether they are convenient.',
    ],
    urgent: [
      'Now. Not after whatever you had planned. Now.',
      'This one decides whether the rest holds. Move.',
    ],
    reminder: [
      'The standing duty. Discipline is what you do when nobody checks.',
      'Again today. A fortress falls through the unwatched gate.',
    ],
    done: [
      'Acceptable. That is high praise and you will not hear more.',
      'Done properly. Continue.',
    ],
  },
  'riza-hawkeye': {
    greeting: [
      'New assignment. Read it through before you start moving.',
      'This is yours. I have checked it twice; you should check it once.',
      'A task came down. Straightforward, which is when people get careless.',
    ],
    urgent: [
      'Priority. Everything else waits, including the comfortable things.',
      'This one now. I will not ask a second time.',
    ],
    reminder: [
      'The routine check. Routine is what keeps anyone standing.',
      'Due again. I log these whether or not anyone reads them.',
    ],
    done: [
      'Clean work. Noted.',
      'Complete, and no loose ends. That is the part that matters.',
    ],
  },
  'winry-rockbell': {
    greeting: [
      'Got a job for you! Treat it properly and it will treat you properly.',
      'New task — and no shortcuts. I can always tell.',
      'Here. Do it right the first time and nobody has to come back to it.',
    ],
    urgent: [
      'This one is breaking! Go fix it before it takes something else with it.',
      'Urgent — and do not you dare bodge it to save five minutes.',
    ],
    reminder: [
      'Maintenance day. Things last because someone bothers.',
      'The regular service. Neglect is just damage on a delay.',
    ],
    done: [
      'Now that is good work. I would sign my name to that.',
      'Finished, and finished well. Do not make me regret the compliment.',
    ],
  },

  // Lycoris Recoil
  'chisato-nishikigi': {
    greeting: [
      'New job! Do not worry, these always look worse than they are.',
      'Something came in — and I already have a plan where nobody gets hurt.',
      'Task for you! I will handle the awkward half if you handle the tedious one.',
    ],
    urgent: [
      'Okay, this one is actually urgent — but we still do it without panicking.',
      'Go! I have got everything behind you covered.',
    ],
    reminder: [
      'The usual round! I genuinely like these ones.',
      'Same job, new day. Feels a bit like home, does it not?',
    ],
    done: [
      'See? Nobody got hurt and it still got done. My favourite outcome.',
      'All finished! I am counting that as a good day.',
    ],
  },
  'takina-inoue': {
    greeting: [
      'Assignment received. I have summarised it; read the summary.',
      'A task. The efficient order is written at the top — follow it.',
      'This is yours. I see no reason to discuss it further.',
    ],
    urgent: [
      'This takes precedence. Reassign everything else.',
      'Urgent. Improvising here would be worse than being late.',
    ],
    reminder: [
      'Scheduled task. Repetition is not a reason to do it poorly.',
      'It recurs today. I have logged it as I always do.',
    ],
    done: [
      'Objective complete. The result is what I expected.',
      'Done. That was the correct approach.',
    ],
  },

  // The Magical Revolution of the Reincarnated Princess
  'anisphia-wynn': {
    greeting: [
      'A task! Which means data! Which means I am already interested!',
      'Ooh, something new to take apart. Do you mind if I experiment slightly?',
      'New assignment! I have four ideas and only one of them is dangerous.',
    ],
    urgent: [
      'No time for the elegant version — we do the version that works! Go!',
      'Urgent! Perfect. Constraints are where the good ideas live.',
    ],
    reminder: [
      'The recurring one! Every repeat is another measurement, really.',
      'Back again. I am starting to see the pattern in it.',
    ],
    done: [
      'It worked! And almost exactly the way I predicted, which is thrilling.',
      'Finished! Write down what you did — that part matters.',
    ],
  },
  'euphyllia-magenta': {
    greeting: [
      'A new task, prepared carefully for you. Please take your time with it.',
      'This has been entrusted to you, and I think rightly so.',
      'Something requires attention. I have set it out clearly.',
    ],
    urgent: [
      'This one is pressing. Please see to it before the rest.',
      'I would not hurry you without cause — but there is cause.',
    ],
    reminder: [
      'The customary duty. There is a quiet dignity in doing it again.',
      'Due today, as always. Constancy is not a small virtue.',
    ],
    done: [
      'Beautifully done. I am glad it was you.',
      'Complete, and with care. That is what I hoped for.',
    ],
  },

  // My Dress-Up Darling
  'marin-kitagawa': {
    greeting: [
      'Okay so — new task, and I am already excited about it! Is that weird?',
      'This one came in and I thought, yes, that is a you job!',
      'New thing to do! We are going to make it look good, obviously.',
    ],
    urgent: [
      'Wait wait wait — this one is urgent! Go go go, I believe in you!',
      'Deadline! Okay. Okay! You have got this, seriously.',
    ],
    reminder: [
      'The regular one! Honestly the routine stuff is kind of comforting.',
      'It is back! Hi, task. We meet again.',
    ],
    done: [
      'AAAH you finished it! That is so good, I am genuinely proud!',
      'Done! Okay, what is next, I am fully invested now.',
    ],
  },

  // Dandadan
  'momo-ayase': {
    greeting: [
      'Here, take this one. And do not make it weird — it is just a task.',
      'New job. Looks normal, which around here means nothing.',
      'This needs doing. I would do it myself but I am handling something worse.',
    ],
    urgent: [
      'Move! This one is going sideways if you stand there thinking.',
      'Urgent. I am not explaining twice, just go.',
    ],
    reminder: [
      'The usual one. Boring is honestly a nice change.',
      'Again today. I will take dull over strange any day.',
    ],
    done: [
      'Nice. Handled, no drama. That is how it should go.',
      'Done? Good. Do not let it go to your head.',
    ],
  },

  // The Apothecary Diaries
  maomao: {
    greeting: [
      'A task. Interesting — though most things are, if you look properly.',
      'Here. I have noted what is odd about it, which is usually the useful part.',
      'This needs doing. I would start by asking why it exists at all.',
    ],
    urgent: [
      'This one is time-sensitive. Delay is itself a decision, and a poor one.',
      'Handle it now. Whatever is causing it will not improve on its own.',
    ],
    reminder: [
      'The recurring one. Repetition is how you learn what normal looks like.',
      'Due again. I keep records so the exception is obvious when it comes.',
    ],
    done: [
      'Done. And now we know something we did not know before.',
      'Complete. I have written down what actually happened, not what was expected.',
    ],
  },

  // Re:Zero
  emilia: {
    greeting: [
      'I brought you a task! I am sure you will manage it kindly and well.',
      'Something new needs doing. I will help however I can, truly.',
      'Here is your next one. I thought it suited you.',
    ],
    urgent: [
      'Oh — this one is urgent. Please hurry, but please also be careful.',
      'It cannot wait. I will stay and keep watch over the rest.',
    ],
    reminder: [
      'The everyday one is back. I find those comforting, honestly.',
      'It is due again today. Small promises are still promises.',
    ],
    done: [
      'You finished it! I am so glad, really I am.',
      'All done. Thank you — I mean that properly.',
    ],
  },

  // ── Voices revisited 2026-09-11, once Nima named the series ───────────────
  // Coco and Nico are written in voice below. Alicia, Clen and Nemu are NOT, and
  // that is deliberate: Clevatess is a series I do not know, and I do not know
  // Nemu's character well enough to imitate her. Warm and neutral is honest;
  // a confident impression of someone I cannot actually place is not.

  // Witch Hat Atelier — Coco: earnest, wonder-struck, told once she could never
  // be a witch and quietly determined to prove otherwise.
  coco: {
    greeting: [
      'Oh! A new task — I want to understand it properly before I touch it.',
      'Something to do! Can I ask what it is *for*? I always want to know that part.',
      'A fresh one. I will draw out the steps first, so I can see the whole shape.',
    ],
    urgent: [
      'This one cannot wait! I will be careful, but I will be quick.',
      'Please hurry — but do not skip the step that makes it safe.',
    ],
    reminder: [
      'The everyday one again. I do not mind; that is how you get good at something.',
      'It came back around! Practice is not the boring part, I think.',
    ],
    done: [
      'We did it! And I know *why* it worked, which is the best bit.',
      'Finished! I am going to write down how, so I never lose it.',
    ],
  },

  // Witch Watch — Nico: cheerful witch, fond of pranks, magic that overshoots.
  'nico-wakatsuki': {
    greeting: [
      'New task! I could do it with magic, but you know how that usually ends.',
      'Ta-da! A job for you. I have deliberately not enchanted it. Probably.',
      'Here you go! I tried helping earlier and made it slightly worse, so — yours!',
    ],
    urgent: [
      'Eep, this one is urgent! Go, go! I will not cast anything, I promise!',
      'Hurry! And if something starts glowing, that was not me.',
    ],
    reminder: [
      'The daily one is back! I like the ones that keep coming round.',
      'Same task, same time. Cosy, right?',
    ],
    done: [
      'Yaaay! Finished, and nothing exploded! Best kind of day.',
      'Done! I am counting that as a win for both of us.',
    ],
  },

  // Clevatess — series unknown to me; see the note above.
  'alicia-glenfall': {
    greeting: [
      'A new task for you. I have laid out what it needs.',
      'This came in and it is yours. Straightforward enough.',
      'Here is the next one. Take it at the pace it deserves.',
    ],
    urgent: ['This one is urgent — please take it ahead of the rest.', 'No time to let this settle. Go.'],
    reminder: ['The regular duty is due again today.', 'Back on the list. Steady work, steadily done.'],
    done: ['Finished, and finished properly.', 'Complete. Onto the next.'],
  },
  clen: {
    greeting: [
      'Something needs doing, and I thought of you.',
      'A task. Quiet one, but it matters.',
      'Here. I will not make a speech about it.',
    ],
    urgent: ['This will not keep. Now, please.', 'Urgent — leave the rest where it is.'],
    reminder: ['The recurring one. Again, as ever.', 'Due today. It always is.'],
    done: ['Done. Good.', 'Handled. That is enough said.'],
  },
  // Witch Watch, believed — voice kept neutral; I do not know her well enough.
  'nemu-miyao': {
    greeting: [
      'A task for you. I have kept the details short.',
      'This one is yours. I trust you with it.',
      'Here is the next thing. No rush beyond the real one.',
    ],
    urgent: ['This needs you now, before anything else.', 'Urgent. Please do not set it down.'],
    reminder: ['The scheduled one has come round again.', 'Due today, same as always.'],
    done: ['Complete. Neatly done.', 'Finished. That is one fewer thing waiting.'],
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
