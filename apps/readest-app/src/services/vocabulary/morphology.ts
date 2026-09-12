/**
 * Deterministic word-form canonicalization for the vocabulary book (save side).
 *
 * The rule engine lives in `services/dictionaries/lemmatize/english.ts`
 * (`inflectionCandidates`, the lexicalized-form guard). This module owns the
 * SAVE contract — ONE answer, always — by arbitrating those rule candidates:
 *
 *   1. the irregular table and ordered rules (see the lemmatize module),
 *   2. an optional dictionary headword — when the lookup popup resolved the
 *      selection through a base-form candidate (MDict `@@@LINK=go` redirects
 *      included), that headword is authoritative,
 *   3. a frequency word list for the headword-less fallback (captures from a
 *      popup that had zero dictionary hits).
 *
 * A candidate that nothing validates is rejected — the surface form is kept
 * rather than saving a bogus stem (`chattering` without a dictionary signal
 * stays `chattering`, never a guessed `chatter`). Non-English words pass
 * through unchanged.
 */

import { inflectionCandidates, isLexicalizedForm } from '@/services/dictionaries/lemmatize/english';
import { normalizedLangCode } from '@/utils/lang';

export interface CanonicalWord {
  /** The form to store as the vocabulary entry (base form when inflected). */
  canonical: string;
  /** The original trimmed input form ("running" when canonical is "run"). */
  surface: string;
  /** True when a rule/irregular/headword actually changed the form. */
  changed: boolean;
}

const ASCII_WORD = /^[a-z][a-z'’-]*$/;

/**
 * Shared input guards: a lowercase ASCII English word with the possessive
 * clitic stripped, or null when the pipeline doesn't apply (other languages,
 * phrases, CJK, or a lexicalized form that must keep its shape).
 */
const resolvableRoot = (word: string, lang?: string | null): string | null => {
  const surface = word.trim();
  if (!surface) return null;
  const langCode = normalizedLangCode(lang) || 'en';
  if (langCode !== 'en') return null;
  const lower = surface.toLowerCase();
  if (!ASCII_WORD.test(lower)) return null;
  const stripped = lower.replace(/['’]s?$/, '');
  const root = stripped !== lower ? stripped : lower;
  if (root !== lower && !ASCII_WORD.test(root)) return null;
  if (isLexicalizedForm(root)) return null;
  return root;
};

/** Extract the first ASCII word from a provider headword ("run①" → "run"). */
const normalizeHeadword = (headword: string): string | null => {
  const match = headword.toLowerCase().match(/[a-z][a-z'’-]*/);
  return match ? match[0] : null;
};
// ---------------------------------------------------------------------------
// Frequency word list — arbitrates rule candidates on the headword-less path
// ---------------------------------------------------------------------------

/**
 * Common English base forms (single line, split once at load). A rule
 * candidate is only canonicalized when it appears here — so `gas → ga` or
 * `chaos → chao` can never be saved, and a rare inflection the list doesn't
 * know simply stays as its surface form (safe) instead of a bogus stem.
 * Dictionary-headword arbitration (the primary path) does not consult it.
 */
const COMMON_BASES = new Set(
  `
  able about accept account ache achieve across act action active actually
  add address admit adopt adult advance advantage adventure advertise advice
  advise afford afraid after afternoon again against age agency agent agree
  agriculture ahead aim air aircraft airline airport alarm album alcohol
  alive all allow almost alone along already alright also although always
  amaze among amount ancient analysis anger angle angry animal ankle
  announce annual another answer antenna anxiety anxious any anybody anymore
  anyone anything anyway apart apartment apologize appear apple apply
  appoint approach approve argue argument arise arm army around arrange
  arrest arrive arrow art article artist as ash ask asleep aspect assist
  assume assure at athlete atmosphere attach attack attempt attend attention
  attitude attract audience author autumn available average avoid awake
  award aware away awful baby back background bacon bad badly bag bake
  balance ball balloon banana band bank bar bare barely bark barn barrel
  base basic basket bat bath bathe battle bay be beach beam bean bear beat
  beautiful beauty because become bed bee beef beer before beg begin behave
  behind believe bell belong below belt bench bend beneath benefit berry
  beside better between beyond bicycle big bike bill bind bird birth bit
  bite bitter black blade blame blank blanket bleed bless blind block blood
  blow blue board boat body boil bomb bone book boot border bore borrow boss
  both bother bottle bottom bounce bound bowl box boy brain brake branch
  brand brave bread break breakfast breath breathe breeze brick bridge brief
  bright brilliant bring broad broadcast broke broken bronze broom brother
  brown brush bubble bucket budget build bulb bunch burden burn burst bury
  bus bush business busy but butter button buy cabbage cabin cable cafe cage
  cake calculate calendar calm camera camp can canal cancel candle cap
  capable capital captain capture car carbon card care career careful
  careless cargo carpet carrot carry cart case cash cast castle cat catch
  cause cave cease ceiling celebrate cell cent center central century
  ceremony certain chain chair chalk challenge chamber chance change channel
  chapter character charge charm chart chase cheap cheat check cheek cheer
  cheese chemical chest chat chicken chief child chill chimney chin chip
  chocolate choice choose church circle circuit citizen city civil claim
  class classic clean clear clerk clever click cliff climate climb clinic
  clock close cloth cloud club clue cluster coach coal coast coat code
  coffee coil coin cold collapse collar collect college colony color column
  combine come comfort command comment commercial commit common communicate
  community company compare compete complain complete complex concern
  concert conclude concrete condition conduct confer confess confident
  confirm conflict confuse congratulate connect consider consist constant
  construct consult contain contemporary content contest continue contract
  contrast contribute control convenient conversation convince cook cool
  copy corner corporate correct cost cottage cotton could council count
  country county couple courage course court cousin cover cow crash crazy
  cream create creature credit crew crisis crop cross crowd crown cruel
  crush cry culture cup curious curl current curse curtain curve custom
  customer cut cycle daily damage dance danger dare dark data date daughter
  dawn day dead deaf deal dear death debate debt decade decide decision
  declare decorate decrease deed deep deer defeat defend define degree delay
  deliver demand demonstrate deny depart depend deposit depth describe
  desert deserve design desire desk desperate despite destroy detail detect
  determine develop device devote diagram dial diamond diary dictation die
  diet differ difficult dig digital dignity dinner dip direct dirt disappear
  disappoint discipline discount discover discuss disease dish dismiss
  dispute distance distant distinct distribute district disturb dive divide
  divorce dizzy do document dog doll dollar domestic dominate donkey donate
  door dot double doubt dough down dozen draft drag dragon drain drama draw
  dream dress drift drill drink drip drive drop drown drug drum dry duck due
  dull dumb dump during dust duty each eager ear early earn earth earthquake
  ease easily east easy eat economic edge educate effect effort egg eight
  either elbow elder elect electric elegant element elephant elevate
  eliminate else elsewhere embarrass emerge emotion emphasize employ empty
  enable encounter encourage end enemy energetic energy engage engine
  engineer enjoy enormous enough ensure enter entertain enthusiasm entire
  entrance entry envelope environment envy equal equip era error erupt
  escape especially essay essential establish estate estimate even evening
  event eventually ever every everybody everyone everything everywhere
  evidence evil exact examine example exceed excellent except exchange
  excite exclude excuse exercise exhaust exhibit exist exit expand expect
  expensive experience experiment expert explain explode explore export
  expose express extend extra extreme eye face facility fact factory fade
  fail fair faith fall false fame familiar family famous fan fancy fantasy
  far farm fashion fast fat fate father fatigue fault favor fear feast
  feather feature feed feel fellow female fence festival fetch fever few
  fiber fiction field fierce fifteen fight figure fill film filter final
  finance find fine finger finish fire firm first fish fit five fix flag
  flame flash flat flavor flee flesh float flood floor flour flow flower flu
  fly focus fold folk follow fond fool foot force forecast forehead foreign
  forest forever forget forgive fork form former fortune forward fossil
  foster found fountain four fraction fragile frame free freeze frequent
  fresh friend fright from front frost frown fruit fry fuel full fun
  function fund funeral funny fur furnish furniture further future gain
  gallery game gap garage garbage garden garlic gas gate gather gaze general
  generate generous gentle genuine gesture get ghost giant gift giggle
  ginger giraffe girl give glad glance glass glide global glory glove glue
  go goal goat gold golden golf good goose govern grab grace grade graduate
  grain grand grandchild granddaughter grandfather grandmother grape grasp
  grass grateful grave gray graze great greedy green greet grief grill grin
  grind grip groan grocery ground group grow guard guess guest guide guilty
  guitar habit hail hair half hall hammer hand handle hang happen happy
  harbor hard hardly harm harvest has hat hate haul have he head headache
  heal health healthy heap hear heart heat heaven heavy hedge heel height
  helicopter hello helmet help hen her here hero hesitate hide high
  highlight hill hint hip hire history hit hive hobby hold hole holiday
  hollow holy home honest honey honor hook hope hop horizon horn horrible
  horse hospital host hot hotel hour house household hover how however hug
  huge human humble humor hunger hunt hurry hurt husband hut hydrogen ice
  icon idea identify idle ignore ill illustrate image imagine imitate
  immediate immense importance important impose impress improve in inch
  include increase indeed independence independent index indicate individual
  industry influence inform initial injure ink inland inner innocent
  innovate input inquiry insect insist inspire install instance instead
  instinct institution instruct instrument insurance intend interest
  interfere interior internal international internet interpret interrupt
  interval interview into introduce invade invent invest investigate invite
  item ivory jacket jam jar jaw jazz jealous jeans jet jewel job join joke
  journey joy judge juice jump junction jungle junior just justice keen keep
  key keyboard kick kid kill kilo kind king kiss kit kitchen kite knee kneel
  knife knit knock knot know knowledge lab label labor lack ladder lady lake
  lamb lamp land landscape lane language lap large laser last late lately
  later latter laugh launch laundry law lawyer lay lazy lead leader leaf
  league lean leap learn lease least leather leave lecture left leg legal
  legend leisure lemon lend length lens less lesson let letter level liberty
  library license lie life lift light lightning like likely limit line link
  lion lip liquid list listen literature little live lively liver load loaf
  loan local locate lock log logic lonely long look loose lose loss lot loud
  love lovely low loyal luck lucky luggage lump lunch lung machine mad
  magazine magic mail main maintain major majority make male mall man manage
  manner manufacture many map marble march margin mark market marriage marry
  mask mass master match material mathematics matter mature maximize may
  maybe mayor me meal mean measure meat mechanic media medical medicine
  medium meet melt member memory mental mention menu merchant mercy mere
  mess message metal method middle midnight might mild mile milk mill
  million mind mine mineral minor minute miracle mirror miss missile mission
  mistake mix model moderate modern modest modify moment monday money
  monitor monkey month mood moon moral more morning most mother motion
  motivate motor mount mountain mouse mouth move movie much mud multiply
  murder muscle museum music must mutual mystery nail naive name narrow
  nation native natural nature naughty naval navigate near neat necessary
  neck need negative neglect negotiate neighbor neither nerve nest net
  network neutral never nevertheless new news next nice night nine noble
  nobody nod noise none nonsense noodle noon nor normal north nose note
  nothing notice notion nourish novel now nowhere nuclear number nurse nut
  obey object observe obtain obvious occasion occupy occur ocean odd offend
  offer office officer official often oil okay old omit on once one onion
  only onto open operate opinion opponent opportunity oppose opposite
  optimistic option or orange orbit orchestra order ordinary organ organize
  origin original other otherwise ought ounce our ours out outcome outdoor
  outer outline output outside outstanding oven over overcome owe owl own ox
  oxygen pace pack pad page pain paint pair palace pale palm pan panel panic
  paper parade paragraph parallel parcel pardon parent park parrot part
  participate particular partly partner party pass passage passenger passion
  past paste path patient pattern pause pay payment peace peaceful peak pear
  peasant pen penalty pencil people pepper perceive perfect perform perhaps
  period permanent permission permit person personal persuade pet phase
  phenomenon philosophy phone photo photograph phrase physical piano pick
  picnic picture piece pierce pigeon pile pilot pin pinch pine pink pipe
  pity pizza place plain plan plane planet plant plastic plate platform play
  pleasant please pleasure plenty plot plow plural pocket poem poet point
  poison polar pole police policy polish polite political politics pollute
  pond pool poor pop popular population porch pork port portion position
  positive possess possible post pot potato potential pound pour poverty
  powder power practical practice praise pray preach precede precious
  predict prefer pregnant prepare present preserve president press pressure
  pretend pretty prevent previous price pride priest primary prince
  principal principle print prior prison private prize probably problem
  procedure process produce product profession professor profit program
  progress project prominent promise promote prompt proof proper property
  propose protect protein proud prove provide province public publish pull
  pulse pump punch punctual punish pupil purchase pure purple purpose purse
  pursue push put puzzle pyramid qualify quality quantity quarrel quarter
  queen question queue quick quiet quilt quit quite quiz rabbit race radar
  radiate radio raft rail rain raise rally random range rapid rare rat rate
  rather ratio rational raw ray reach react read ready real realize really
  reason receive recent recipe recite recognize recommend record recover
  recruit red reduce refer reflect refresh refuse regard region regret
  regular reject relate relax release relevant reliable relief religion rely
  remain remark remember remind remote remove renew rent repair repeat
  replace reply report represent reproduce request require rescue research
  resemble reserve resist resource respect respond responsible rest
  restaurant result resume retail retire return reveal revenge revenue
  review revise revolt reward rhythm rice rich rid ride ridge ridiculous
  right rigid ring rinse rip ripe rise risk rival river road roast rob robot
  rock rocket rod role roll roof room root rope rot rough round route
  routine row royal rub rubber rude rug ruin rule rumble run rural rush rust
  sacrifice sad safe sail saint sake salad salary sale salmon salt same
  sample sand sandwich satellite satisfaction satisfy sauce sausage save saw
  say scale scan scare scatter scene scent schedule scheme scholar school
  science scissors scope score scout scream screen screw script sea seal
  search season seat second secret secretary section secure see seed seek
  seem segment seize seldom select self sell senate send senior sense
  separate sequence series serious servant serve service session set settle
  seven several severe sew shade shadow shake shallow shame shape share
  shark sharp shave she sheep sheet shelf shell shelter shield shift shine
  ship shirt shiver shock shoe shoot shop shore short shot should shoulder
  shout shove show shower shrug shut shy sick side sigh sight sign signal
  silence silent silk silly silver similar simple simply since sincere sing
  single sink sip sir sister sit site situation six size skate sketch ski
  skip skill skin skirt sky slam slap sleep sleeve slice slide slight slip
  slope slow small smart smell smile smoke smooth snake snap snatch snow sob
  so soak soap soar social society sock soda soft soil solar soldier solid
  solve some somebody somehow someone something sometime sometimes somewhat
  somewhere son song soon sophisticated sore sorrow sorry sort soul sound
  soup source south space spare spark speak special species specific speech
  speed spell spend spice spider spin spirit split spoil sponsor spoon sport
  spot spread spring sprinkle spy square squeeze stable staff stage stair
  stake stamp stand star stare start starve state station statue status stay
  steady steal steam steel steep steer stem step stereo stern stick stiff
  still sting stir stitch stock stomach stone stop store storm story stove
  straight strange stranger strategy stream street strength stress stretch
  strict strike string strip stroke strong structure struggle student studio
  study stuff stupid sturdy style subject substance substitute subtle suburb
  succeed success such sudden suffer sugar suggest suit summer sun supervise
  supper supply support suppose sure surface surge surprise surround survey
  survive suspect sustain swallow swamp swear sweat sweater sweep sweet
  swell swim swing switch sword symbol sympathy system table tablet tackle
  tag tail tailor take tale talent talk tall tame tank tap tape target task
  taste tattoo taxi tea teach team tear tease technical technique teeth
  telephone telescope television tell temper temperature temple temporary
  tend tender tennis tense term terrible territory terror test text than
  thank that the theater theft their them theme then theory there these they
  thick thin thing think third thirst thirteen this thorough those though
  thought thousand thread threat thrive throat throne through throughout
  throw thumb thunder thus ticket tide tidy tie tight till timber time tin
  tiny tip tire title to toast tobacco today toe together toilet tolerate
  tomato tomorrow ton tone tongue tonight too tool tooth top topic total
  touch tough tour tourist toward towel tower town toy trace track trade
  tradition traffic trail train transfer transform translate transport trap
  travel tray treasure treat tremble trend trial triangle tribe trick triple
  triumph troop tropical trouble truck true truly trust truth try tube
  tuition tumble tune tunnel turkey turn turtle tusk twelve twenty twice
  twin twist two type typical ugly ultimate umbrella unable uncle under
  undergo understand undertake unfair unfold unhappy uniform union unique
  unit universe university unless until unusual up upon upper upset urban
  urge urgent us use useful usual utility vacation vaccine vacuum vague vain
  valid valley valuable value van vanish vapor variable variety various vary
  vast vegetable vehicle venture verse version very vessel veteran via
  vibrate vice victim victory video view village violence violin virtual
  virus visible vision visit visual vital vitamin vivid vocal voice volume
  volunteer vote voyage wage wagon waist wait wake walk wall wander want war
  warm warn wash waste watch water wave way weak wealth weapon wear weave
  website wedding weed week weigh welcome welfare well west wet whale what
  whatever wheat wheel when whenever where whereas whether which while
  whisper whistle white who whole whom whose why wicked wide widow width
  wife wild will win wind window wine wing wipe wire wisdom wise wish
  witness wolf woman wonder wood wool word work world worse worship worth
  wound wrap wreck wrestle wrist write wrong yard yarn yawn year yell yellow
  yes yesterday yet you young your youth zero zone zoo thesis chop involve
  iron island isolate issue
  `
    .split(/\s+/)
    .filter(Boolean),
);

// ---------------------------------------------------------------------------
// Canonicalization
// ---------------------------------------------------------------------------

/**
 * Resolve a captured word to the form the vocabulary book should store.
 *
 * Priority: possessive strip → lexicalized-form guard (a form that is itself
 * a word keeps its shape) → dictionary headword (when the lookup fell back to
 * a base-form candidate) → first rule candidate present in the frequency
 * list. When nothing validates, the surface form is kept — never a bogus stem.
 */
export const canonicalizeWord = (
  word: string,
  lang?: string | null,
  opts: { headword?: string | null } = {},
): CanonicalWord => {
  const surface = word.trim();
  const keep = (): CanonicalWord => ({ canonical: surface, surface, changed: false });
  const root = resolvableRoot(word, lang);
  if (root === null) return keep();
  const lower = surface.toLowerCase();
  const candidates = inflectionCandidates(root);
  if (candidates.length === 0) {
    // A pure possessive ("John's") still resolves to the bare noun, keeping
    // the original casing rather than lowercasing the whole word.
    if (root !== lower) {
      const bare = surface.replace(/['’]s?$/, '');
      return { canonical: bare, surface, changed: bare.toLowerCase() !== lower };
    }
    return keep();
  }

  const headword = opts.headword ? normalizeHeadword(opts.headword) : null;
  if (headword && headword !== root && candidates.includes(headword)) {
    return { canonical: headword, surface, changed: true };
  }
  for (const candidate of candidates) {
    if (COMMON_BASES.has(candidate)) return { canonical: candidate, surface, changed: true };
  }
  return keep();
};
