/**
 * @jest-environment jsdom
 */

import { DOMQuestionExtractor } from '../../extension/src/content/extractor';
import { createQuestionFingerprint, normalizeText } from '../../extension/src/content/fingerprint';
import { DOMInteractionManager } from '../../extension/src/content/interaction';

describe('DOM Extraction Engine & Fingerprinting', () => {
  let extractor: DOMQuestionExtractor;
  let interaction: DOMInteractionManager;

  beforeEach(() => {
    document.body.innerHTML = '';
    extractor = new DOMQuestionExtractor();
    interaction = new DOMInteractionManager();
  });

  describe('Question Fingerprinting', () => {
    it('should generate consistent fingerprint regardless of casing or extra whitespace', () => {
      const q1 = '  What is   the capital of France?  ';
      const opts1 = [{ id: 'A', text: ' Paris ' }, { id: 'B', text: 'London' }];

      const q2 = 'what is the capital of france';
      const opts2 = [{ id: 'B', text: 'London' }, { id: 'A', text: 'paris' }];

      const fp1 = createQuestionFingerprint(q1, opts1);
      const fp2 = createQuestionFingerprint(q2, opts2);

      expect(fp1).toBe(fp2);
    });

    it('should generate distinct fingerprints for different questions', () => {
      const fp1 = createQuestionFingerprint('What is 2 + 2?', [{ text: '4' }, { text: '5' }]);
      const fp2 = createQuestionFingerprint('What is 2 + 3?', [{ text: '4' }, { text: '5' }]);
      expect(fp1).not.toBe(fp2);
    });
  });

  describe('Standard Radio MCQ Extraction', () => {
    it('should extract radio buttons grouped by name with label elements', () => {
      document.body.innerHTML = `
        <div class="question-container">
          <p class="question-text">Question 1: Which protocol is used for secure web browsing?</p>
          <div class="options">
            <label><input type="radio" name="q1" value="HTTP"> HTTP</label>
            <label><input type="radio" name="q1" value="HTTPS"> HTTPS</label>
            <label><input type="radio" name="q1" value="FTP"> FTP</label>
            <label><input type="radio" name="q1" value="SSH"> SSH</label>
          </div>
        </div>
      `;

      const questions = extractor.extractAllQuestions();
      expect(questions.length).toBe(1);

      const q = questions[0];
      expect(q.questionNumber).toBe(1);
      expect(q.questionText).toContain('Which protocol is used for secure web browsing?');
      expect(q.options.length).toBe(4);
      expect(q.options[0].text).toContain('HTTP');
      expect(q.options[1].text).toContain('HTTPS');
      expect(q.extractionStrategy).toBe('multi-question-list');
    });

    it('should extract radio buttons using for/id label association', () => {
      document.body.innerHTML = `
        <div>
          <h3>Question 2: What is the primary function of DNS?</h3>
          <input type="radio" id="dns_a" name="dns_group" value="A">
          <label for="dns_a">Resolves domain names to IP addresses</label>

          <input type="radio" id="dns_b" name="dns_group" value="B">
          <label for="dns_b">Encrypts data packets</label>

          <input type="radio" id="dns_c" name="dns_group" value="C">
          <label for="dns_c">Routes physical cables</label>
        </div>
      `;

      const questions = extractor.extractAllQuestions();
      expect(questions.length).toBe(1);

      const q = questions[0];
      expect(q.questionNumber).toBe(2);
      expect(q.options.length).toBe(3);
      expect(q.options[0].text).toBe('Resolves domain names to IP addresses');
    });
  });

  describe('ARIA Accessible Controls Extraction', () => {
    it('should extract questions using role="radiogroup" and role="radio"', () => {
      document.body.innerHTML = `
        <div role="radiogroup" aria-label="Question 3: In Python, which keyword defines a function?">
          <div role="radio" aria-checked="false" aria-label="func">func</div>
          <div role="radio" aria-checked="false" aria-label="def">def</div>
          <div role="radio" aria-checked="false" aria-label="function">function</div>
        </div>
      `;

      const questions = extractor.extractAllQuestions();
      expect(questions.length).toBe(1);

      const q = questions[0];
      expect(q.extractionStrategy).toBe('custom-accessible');
      expect(q.options.length).toBe(3);
      expect(q.options[1].text).toBe('def');
    });
  });

  describe('Controlled DOM Interaction', () => {
    it('should select an option and set checked attribute', () => {
      document.body.innerHTML = `
        <form>
          <input type="radio" id="opt_b" name="quiz" value="B">
          <label for="opt_b">Option B</label>
        </form>
      `;

      const radio = document.getElementById('opt_b') as HTMLInputElement;
      expect(radio.checked).toBe(false);

      const res = interaction.selectOption('B', '#opt_b');
      expect(res.success).toBe(true);
      expect(radio.checked).toBe(true);
    });

    it('should navigate to next question by clicking next button', () => {
      document.body.innerHTML = `
        <div>
          <button id="next-btn">Next Question &rarr;</button>
        </div>
      `;

      let clicked = false;
      document.getElementById('next-btn')!.addEventListener('click', () => {
        clicked = true;
      });

      const res = interaction.navigateNextQuestion();
      expect(res.success).toBe(true);
      expect(clicked).toBe(true);
    });
  });
});

