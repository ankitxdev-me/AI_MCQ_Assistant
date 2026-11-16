/**
 * @jest-environment jsdom
 */

import { DOMQuestionExtractor } from '../../extension/src/content/extractor';
import { DOMInteractionManager } from '../../extension/src/content/interaction';
import { matchAIMultipleAnswersToOptions } from '../../extension/src/content/matcher';
import { tableToMarkdown } from '../../extension/src/content/media';

describe('Extension fixes', () => {
  let extractor: DOMQuestionExtractor;
  let interaction: DOMInteractionManager;

  beforeEach(() => {
    document.body.innerHTML = '';
    extractor = new DOMQuestionExtractor();
    interaction = new DOMInteractionManager();
  });

  it('ignores questions hidden by a wizard (display:none)', () => {
    document.body.innerHTML = `
      <div class="question-card"><div class="question-title">Question 1: Which is a queue?</div>
        <label><input type="radio" name="a" value="A"> FIFO</label>
        <label><input type="radio" name="a" value="B"> LIFO</label></div>
      <div class="question-card" style="display:none"><div class="question-title">Question 2: Hidden one?</div>
        <label><input type="radio" name="b" value="A"> X</label>
        <label><input type="radio" name="b" value="B"> Y</label></div>`;
    const qs = extractor.extractAllQuestions();
    expect(qs).toHaveLength(1);
    expect(qs[0].questionText).toContain('Which is a queue');
  });

  it('treats same wording + same options but different code as two different questions', () => {
    const card = (name: string, code: string) => `
      <div class="question-card"><div class="question-title">What is the output of the code?</div>
        <pre>${code}</pre>
        <label><input type="radio" name="${name}" value="A"> 1</label>
        <label><input type="radio" name="${name}" value="B"> 2</label></div>`;
    document.body.innerHTML = card('q1', 'console.log(1)') + card('q2', 'console.log(2)');
    const qs = extractor.extractAllQuestions();
    expect(qs).toHaveLength(2);
    expect(qs[0].fingerprint).not.toBe(qs[1].fingerprint);
    expect(qs[0].questionText).toContain('[CODE]');
    expect(qs[0].questionText).toContain('console.log(1)');
    expect(qs[1].questionText).toContain('console.log(2)');
  });

  it('adds "match the columns" tables to the question as a Markdown table', () => {
    document.body.innerHTML = `
      <div class="question-card"><div class="question-title">Match Column 1 with Column 2.</div>
        <table><tr><th>Column 1</th><th>Column 2</th></tr>
               <tr><td>1) GET</td><td>A) Delete</td></tr>
               <tr><td>2) POST</td><td>B) Read</td></tr></table>
        <label><input type="radio" name="m" value="A"> 1 - B, 2 - A</label>
        <label><input type="radio" name="m" value="B"> 1 - A, 2 - B</label></div>`;
    const [q] = extractor.extractAllQuestions();
    expect(q.questionText).toContain('[TABLE]');
    expect(q.questionText).toContain('| 1) GET | A) Delete |');
    expect(tableToMarkdown(document.querySelector('table')!)).toContain('| --- | --- |');
  });

  it('reads True/False statements that have no question mark', () => {
    const tf = (n: string, statement: string) => `
      <section><p>${statement}</p>
        <div><label><input type="radio" name="${n}" value="T"> True</label>
             <label><input type="radio" name="${n}" value="F"> False</label></div></section>`;
    document.body.innerHTML = tf('t1', 'HTTP is a stateless protocol.') + tf('t2', 'TCP does not guarantee delivery.');
    const qs = extractor.extractAllQuestions();
    expect(qs).toHaveLength(2);
    expect(qs[0].questionText).toContain('stateless');
    expect(qs[1].questionText).toContain('guarantee delivery');
    expect(qs[0].fingerprint).not.toBe(qs[1].fingerprint);
  });

  it('finds True/False answers drawn as buttons instead of radios', () => {
    document.body.innerHTML = `
      <main><p>The DNS resolves domain names to IP addresses.</p>
        <div class="choices"><button class="choice">True</button><button class="choice">False</button></div>
        <button>SUBMIT</button></main>`;
    const qs = extractor.extractAllQuestions();
    expect(qs).toHaveLength(1);
    expect(qs[0].options.map((o) => o.text)).toEqual(['True', 'False']);
    expect(qs[0].questionText).toContain('DNS resolves');
  });

  it('clicks the exact option "30", not "3000", when falling back to text', () => {
    document.body.innerHTML = `
      <label><input type="radio" name="p" value="1"> 3000</label>
      <label><input type="radio" name="p" value="2"> 30</label>
      <label><input type="radio" name="p" value="3"> 3001</label>
      <label><input type="radio" name="p" value="4"> 300</label>`;
    const res = interaction.selectOption('B', '#does-not-exist', '30');
    expect(res.success).toBe(true);
    const checked = document.querySelector<HTMLInputElement>('input:checked');
    expect(checked?.value).toBe('2');
  });

  it('keeps a checkbox checked (the old wrapper click toggled it back off)', () => {
    document.body.innerHTML = `
      <label><input type="checkbox" id="c1"> Alpha</label>
      <label><input type="checkbox" id="c2"> Beta</label>`;
    const res = interaction.selectMultipleOptions(['A'], [
      { id: 'A', text: 'Alpha', elementSelector: '#c1' },
      { id: 'B', text: 'Beta', elementSelector: '#c2' },
    ]);
    expect(res.success).toBe(true);
    expect((document.getElementById('c1') as HTMLInputElement).checked).toBe(true);
    expect((document.getElementById('c2') as HTMLInputElement).checked).toBe(false);
  });

  it('never clicks "Submit Test" or links that leave the page', () => {
    document.body.innerHTML = `
      <button>Submit Test</button>
      <a href="https://nextjs.org">Next</a>
      <button disabled>Submit</button>`;
    expect(interaction.findActionButton('submit')).toBeNull();
    expect(interaction.findActionButton('next')).toBeNull();

    document.body.innerHTML += `<button id="ok">SUBMIT</button><button id="nx">Next Question →</button>`;
    expect(interaction.findActionButton('submit')?.id).toBe('ok');
    expect(interaction.findActionButton('next')?.id).toBe('nx');
  });

  it('no longer guesses the first option when a multi-answer cannot be matched', () => {
    const res = matchAIMultipleAnswersToOptions(
      { selected_option_id: 'Z', answer_text: 'nothing like the options' },
      [
        { id: 'A', text: 'Alpha' },
        { id: 'B', text: 'Beta' },
      ],
    );
    expect(res.isMatched).toBe(false);
  });

  it('never uses the Google Tag Manager <noscript> snippet as the question', () => {
    const ns = document.createElement('noscript');
    ns.textContent = '<iframe src="https://www.googletagmanager.com/ns.html?id=GTM-ABC123" height="0" width="0"></iframe>';
    document.body.appendChild(ns);
    const root = document.createElement('div');
    root.innerHTML = `
      <div><div><span>Question 3</span></div></div>
      <div><div>
        <div><label><input type="radio" name="s" value="1"> Stack</label></div>
        <div><label><input type="radio" name="s" value="2"> Queue</label></div>
      </div></div>`;
    document.body.appendChild(root);
    const [q] = extractor.extractAllQuestions();
    expect(q.questionText).not.toContain('iframe');
    expect(q.questionText).not.toContain('googletagmanager');
    expect(extractor.hasQuestionMark('see https://x.com/ns.html?id=1')).toBe(false);
    expect(extractor.hasQuestionMark('Which one is FIFO?')).toBe(true);
  });

  it('detects an "Enter your answer" question and types the answer into it', () => {
    document.body.innerHTML = `
      <main>
        <p>In a range query, if <code>prefix = [3, 8, 12, 20]</code>, what is the sum from index <code>1</code> to <code>3</code> ?</p>
        <hr/>
        <textarea placeholder="Enter your answer"></textarea>
        <button>SHOW ANSWER</button><button>SUBMIT</button><button>SKIP</button>
      </main>`;
    const qs = extractor.extractAllQuestions();
    expect(qs).toHaveLength(1);
    expect(qs[0].questionType).toBe('DESCRIPTIVE');
    expect(qs[0].options).toEqual([]);
    expect(qs[0].questionText).toContain('prefix = [3, 8, 12, 20]');

    let seen = '';
    document.querySelector('textarea')!.addEventListener('input', (e) => (seen = (e.target as HTMLTextAreaElement).value));
    const res = interaction.fillTextAnswer(qs[0].inputSelector, '17');
    expect(res.success).toBe(true);
    expect(seen).toBe('17'); // the page's input listener saw the typed value
  });

  it('ignores search boxes and multi-field forms as typed-answer questions', () => {
    document.body.innerHTML = `<header><input type="text" placeholder="Search courses"></header><p>Welcome back to your dashboard!</p>`;
    expect(extractor.extractAllQuestions()).toHaveLength(0);
    document.body.innerHTML = `<form><p>Contact us about anything?</p><input type="text"><input type="text"><button>SUBMIT</button></form>`;
    expect(extractor.extractAllQuestions()).toHaveLength(0);
  });

  it('keeps a custom code panel (line-number gutter) out of the prompt text', () => {
    const lines = ['f(Node a,Node b)', 'temp1=a', 'temp2=b', 'carry=0', 'ans=new Node(-1)'];
    document.body.innerHTML = `
      <div class="q">
        <div>
          <p>What is the primary objective of the below pseudo code :</p>
          <div class="code-view" style="font-family: 'Fira Code', monospace">
            <div class="gutter">${lines.map((_, i) => `<div>${i + 1}</div>`).join('')}</div>
            <div class="lines">${lines.map((l) => `<div><span class="guide">םםםם</span>${l}</div>`).join('')}</div>
          </div>
        </div>
        <hr/>
        <div><label><input type="radio" name="p" value="1"> To find the product of two numbers</label></div>
        <div><label><input type="radio" name="p" value="2"> To reverse a linked list</label></div>
        <div><label><input type="radio" name="p" value="3"> To calculate the sum of two numbers represented as linked lists</label></div>
      </div>`;
    const [q] = extractor.extractAllQuestions();
    const prompt = q.questionText.split('[CODE]')[0];
    expect(prompt).toContain('primary objective of the below pseudo code');
    expect(prompt).not.toMatch(/12345/);
    expect(prompt).not.toContain('temp1=a');
    expect(q.questionText).toContain('[CODE]');
    expect(q.questionText).toContain('temp1=a');
    expect(q.questionText).not.toContain('םםםם');
    expect(q.options).toHaveLength(3);
  });

  it('strips line-number gutters and junk glyphs from code text', () => {
    const { stripLineNumbers, stripJunkChars } = require('../../extension/src/content/code');
    expect(stripLineNumbers('1\n2\n3\nf(a)\nx=1\ny=2')).toBe('f(a)\nx=1\ny=2');
    expect(stripLineNumbers('1234567891011f(Node a,Node b)\ntemp1=a')).toBe('f(Node a,Node b)\ntemp1=a');
    expect(stripLineNumbers('1 let a = 1\n2 let b = 2\n3 print(a)')).toBe('let a = 1\nlet b = 2\nprint(a)');
    expect(stripLineNumbers('x = 10\nprint(x)')).toBe('x = 10\nprint(x)'); // no gutter: unchanged
    expect(stripJunkChars('if(a) ││││ sum = ____')).toBe('if(a)  sum = ____');
  });

  it('detects sequence wording like "set the following options in sequence"', () => {
    expect(extractor.isOrderingPrompt('Set the following options in sequence')).toBe(true);
    expect(extractor.isOrderingPrompt('Arrange the steps in the correct order')).toBe(true);
    expect(extractor.isOrderingPrompt('What is the time complexity of binary search?')).toBe(false);
    // the course instructions page from the live run
    expect(extractor.isOrderingPrompt('You must answer all the MCQs correctly in order to mark your practice as completed.')).toBe(false);
  });

  it('does not turn an instructions list into a drag-and-drop question', () => {
    document.body.innerHTML = `
      <main><h3>Instructions</h3>
        <p>You must answer all the MCQs correctly in order to mark your practice as completed.</p>
        <ul><li>Number of Questions: 15</li><li>Assessment Name: MCQ Practice</li><li>Marking Scheme: All questions have equal weightage</li></ul>
        <button>Start Practice</button></main>`;
    expect(extractor.extractAllQuestions()).toHaveLength(0);
  });
});
