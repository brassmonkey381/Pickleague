-- ============================================================
-- Best-effort gender backfill from first names
--
-- Run AFTER migration_add_mixed_doubles.sql.
--
-- Strategy:
--   1. Only update profiles where gender IS NULL (don't overwrite anything
--      a user has already set themselves).
--   2. Lower-case + trim the first whitespace-delimited token of full_name
--      and look it up in a CASE expression of common English first names.
--   3. Names not in the table stay NULL — those users will see a
--      "set your gender" hint in the Profile screen and their doubles
--      matches will stay 'unspecified' until they fill it in.
--   4. After the UPDATE, call recompute_doubles_ratings() to redo the
--      ELO replay with the new gender data.
--
-- Review the SELECT block at the bottom after running — anyone you
-- recognize as miscategorized can be fixed with a one-liner UPDATE.
-- ============================================================

update public.profiles
   set gender = case lower(split_part(trim(full_name), ' ', 1))
     -- ── Male ─────────────────────────────────────────────
     when 'aaron'   then 'male' when 'adam'    then 'male' when 'adrian'  then 'male'
     when 'alan'    then 'male' when 'albert'  then 'male' when 'alex'    then null  -- ambiguous
     when 'alexander' then 'male' when 'andrew' then 'male' when 'andy'   then 'male'
     when 'anthony' then 'male' when 'antonio' then 'male' when 'arthur'  then 'male'
     when 'austin'  then 'male' when 'barry'   then 'male' when 'ben'     then 'male'
     when 'benjamin' then 'male' when 'bill'   then 'male' when 'billy'   then 'male'
     when 'bob'     then 'male' when 'bobby'   then 'male' when 'brad'    then 'male'
     when 'bradley' then 'male' when 'brandon' then 'male' when 'brendan' then 'male'
     when 'brent'   then 'male' when 'brett'   then 'male' when 'brian'   then 'male'
     when 'bruce'   then 'male' when 'bryan'   then 'male' when 'caleb'   then 'male'
     when 'carl'    then 'male' when 'carlos'  then 'male' when 'chad'    then 'male'
     when 'charles' then 'male' when 'charlie' then null  -- ambiguous
     when 'chris'   then null  -- ambiguous (Christopher / Christine)
     when 'christopher' then 'male' when 'clayton' then 'male' when 'cody' then 'male'
     when 'colin'   then 'male' when 'connor'  then 'male' when 'corey'   then 'male'
     when 'craig'   then 'male' when 'curtis'  then 'male' when 'dale'    then 'male'
     when 'dan'     then 'male' when 'daniel'  then 'male' when 'danny'   then 'male'
     when 'darren'  then 'male' when 'dave'    then 'male' when 'david'   then 'male'
     when 'dean'    then 'male' when 'dennis'  then 'male' when 'derek'   then 'male'
     when 'devin'   then 'male' when 'dominic' then 'male' when 'don'     then 'male'
     when 'donald'  then 'male' when 'doug'    then 'male' when 'douglas' then 'male'
     when 'drew'    then 'male' when 'duncan'  then 'male' when 'dustin'  then 'male'
     when 'dwayne'  then 'male' when 'dylan'   then 'male' when 'earl'    then 'male'
     when 'ed'      then 'male' when 'eddie'   then 'male' when 'edgar'   then 'male'
     when 'edward'  then 'male' when 'eli'     then 'male' when 'elias'   then 'male'
     when 'eric'    then 'male' when 'ernest'  then 'male' when 'ethan'   then 'male'
     when 'eugene'  then 'male' when 'evan'    then 'male' when 'felix'   then 'male'
     when 'francis' then null  -- ambiguous
     when 'frank'   then 'male' when 'franklin' then 'male' when 'fred'   then 'male'
     when 'frederick' then 'male' when 'gabriel' then 'male' when 'gary'  then 'male'
     when 'gavin'   then 'male' when 'george'  then 'male' when 'gerald' then 'male'
     when 'gordon'  then 'male' when 'graham'  then 'male' when 'grant'  then 'male'
     when 'greg'    then 'male' when 'gregory' then 'male' when 'harold' then 'male'
     when 'harry'   then 'male' when 'harvey'  then 'male' when 'henry'  then 'male'
     when 'howard'  then 'male' when 'hugh'    then 'male' when 'ian'    then 'male'
     when 'ivan'    then 'male' when 'jack'    then 'male' when 'jackson' then 'male'
     when 'jacob'   then 'male' when 'jake'    then 'male' when 'james'  then 'male'
     when 'jamie'   then null  -- ambiguous
     when 'jared'   then 'male' when 'jason'   then 'male' when 'jay'    then 'male'
     when 'jeff'    then 'male' when 'jeffrey' then 'male' when 'jeremy' then 'male'
     when 'jerry'   then 'male' when 'jesse'   then null  -- ambiguous
     when 'jim'     then 'male' when 'jimmy'   then 'male' when 'joe'    then 'male'
     when 'joel'    then 'male' when 'john'    then 'male' when 'johnny' then 'male'
     when 'jon'     then 'male' when 'jonathan' then 'male' when 'jordan' then null  -- ambiguous
     when 'jose'    then 'male' when 'joseph'  then 'male' when 'josh'   then 'male'
     when 'joshua'  then 'male' when 'juan'    then 'male' when 'julian' then 'male'
     when 'justin'  then 'male' when 'keith'   then 'male' when 'kelly' then null  -- ambiguous
     when 'ken'     then 'male' when 'kenneth' then 'male' when 'kevin' then 'male'
     when 'kirk'    then 'male' when 'kyle'    then 'male' when 'lance' then 'male'
     when 'larry'   then 'male' when 'lawrence' then 'male' when 'lee'  then null  -- ambiguous
     when 'leo'     then 'male' when 'leonard' then 'male' when 'leslie' then null  -- ambiguous
     when 'levi'    then 'male' when 'liam'    then 'male' when 'lloyd' then 'male'
     when 'logan'   then null  -- usually male, but ambiguous
     when 'louis'   then 'male' when 'luca'    then 'male' when 'lucas' then 'male'
     when 'luis'    then 'male' when 'luke'    then 'male' when 'malcolm' then 'male'
     when 'manuel'  then 'male' when 'marc'    then 'male' when 'marco' then 'male'
     when 'marcus'  then 'male' when 'mario'   then 'male' when 'mark'  then 'male'
     when 'martin'  then 'male' when 'mason'   then 'male' when 'matt'  then 'male'
     when 'matthew' then 'male' when 'maurice' then 'male' when 'max'   then 'male'
     when 'maxwell' then 'male' when 'michael' then 'male' when 'mike'  then 'male'
     when 'mitchell' then 'male' when 'morgan' then null  -- ambiguous
     when 'nathan'  then 'male' when 'neal'    then 'male' when 'neil'  then 'male'
     when 'nicholas' then 'male' when 'nick'   then 'male' when 'noah'  then 'male'
     when 'oliver'  then 'male' when 'omar'    then 'male' when 'oscar' then 'male'
     when 'owen'    then 'male' when 'pablo'   then 'male' when 'pat'   then null  -- ambiguous
     when 'patrick' then 'male' when 'paul'    then 'male' when 'pedro' then 'male'
     when 'peter'   then 'male' when 'phil'    then 'male' when 'philip' then 'male'
     when 'phillip' then 'male' when 'pierre'  then 'male' when 'quentin' then 'male'
     when 'quinn'   then null  -- ambiguous
     when 'ralph'   then 'male' when 'randall' then 'male' when 'randy' then 'male'
     when 'raul'    then 'male' when 'ray'     then 'male' when 'raymond' then 'male'
     when 'reginald' then 'male' when 'rene'   then null  -- ambiguous
     when 'rich'    then 'male' when 'richard' then 'male' when 'rick'  then 'male'
     when 'ricky'   then 'male' when 'rob'     then 'male' when 'robert' then 'male'
     when 'roberto' then 'male' when 'rod'     then 'male' when 'rodney' then 'male'
     when 'roger'   then 'male' when 'roland'  then 'male' when 'ron'   then 'male'
     when 'ronald'  then 'male' when 'ross'    then 'male' when 'roy'   then 'male'
     when 'russell' then 'male' when 'ryan'    then 'male' when 'sam'   then null  -- ambiguous
     when 'samuel'  then 'male' when 'scott'   then 'male' when 'sean'  then 'male'
     when 'sebastian' then 'male' when 'seth'  then 'male' when 'shane' then 'male'
     when 'shawn'   then 'male' when 'shaun'   then 'male' when 'simon' then 'male'
     when 'spencer' then 'male' when 'stanley' then 'male' when 'stephen' then 'male'
     when 'steve'   then 'male' when 'steven'  then 'male' when 'stuart' then 'male'
     when 'taylor'  then null  -- ambiguous
     when 'ted'     then 'male' when 'terry'   then null  -- ambiguous
     when 'theodore' then 'male' when 'thomas' then 'male' when 'tim'   then 'male'
     when 'timothy' then 'male' when 'tobias'  then 'male' when 'todd'  then 'male'
     when 'tom'     then 'male' when 'tony'    then 'male' when 'travis' then 'male'
     when 'trevor'  then 'male' when 'tyler'   then 'male' when 'vance' then 'male'
     when 'victor'  then 'male' when 'vincent' then 'male' when 'walter' then 'male'
     when 'warren'  then 'male' when 'wayne'   then 'male' when 'wesley' then 'male'
     when 'william' then 'male' when 'willie'  then 'male' when 'xavier' then 'male'
     when 'zach'    then 'male' when 'zachary' then 'male' when 'zane'  then 'male'

     -- ── Female ───────────────────────────────────────────
     when 'abigail'   then 'female' when 'addison'  then 'female' when 'alexa' then 'female'
     when 'alexandra' then 'female' when 'alexis'   then 'female' when 'alice' then 'female'
     when 'alicia'    then 'female' when 'allison'  then 'female' when 'alyssa' then 'female'
     when 'amanda'    then 'female' when 'amber'    then 'female' when 'amy'   then 'female'
     when 'andrea'    then 'female' when 'angela'   then 'female' when 'anna'  then 'female'
     when 'anne'      then 'female' when 'annie'    then 'female' when 'april' then 'female'
     when 'ashley'    then 'female' when 'audrey'   then 'female' when 'ava'   then 'female'
     when 'barbara'   then 'female' when 'beatrice' then 'female' when 'becky' then 'female'
     when 'beth'      then 'female' when 'bethany'  then 'female' when 'betty' then 'female'
     when 'beverly'   then 'female' when 'brenda'   then 'female' when 'bridget' then 'female'
     when 'brittany'  then 'female' when 'brooke'   then 'female' when 'caitlin' then 'female'
     when 'cameron'   then null   -- ambiguous
     when 'candace'   then 'female' when 'carla'    then 'female' when 'carmen' then 'female'
     when 'carol'     then 'female' when 'caroline' then 'female' when 'carolyn' then 'female'
     when 'casey'     then null   -- ambiguous
     when 'cassandra' then 'female' when 'catherine' then 'female' when 'cathy' then 'female'
     when 'charlotte' then 'female' when 'cheryl'   then 'female' when 'chloe' then 'female'
     when 'christina' then 'female' when 'christine' then 'female' when 'cindy' then 'female'
     when 'claire'    then 'female' when 'claudia'  then 'female' when 'colleen' then 'female'
     when 'connie'    then 'female' when 'courtney' then 'female' when 'crystal' then 'female'
     when 'cynthia'   then 'female' when 'daisy'    then 'female' when 'dana' then null  -- ambiguous
     when 'danielle'  then 'female' when 'darlene'  then 'female' when 'dawn'  then 'female'
     when 'deanna'    then 'female' when 'deborah'  then 'female' when 'debra' then 'female'
     when 'denise'    then 'female' when 'diana'    then 'female' when 'diane' then 'female'
     when 'donna'     then 'female' when 'doris'    then 'female' when 'dorothy' then 'female'
     when 'eileen'    then 'female' when 'elaine'   then 'female' when 'eleanor' then 'female'
     when 'elena'     then 'female' when 'elizabeth' then 'female' when 'ella' then 'female'
     when 'ellen'     then 'female' when 'emily'    then 'female' when 'emma'  then 'female'
     when 'erica'     then 'female' when 'erin'     then 'female' when 'eva'   then 'female'
     when 'evelyn'    then 'female' when 'faith'    then 'female' when 'fiona' then 'female'
     when 'frances'   then 'female' when 'gabriella' then 'female' when 'gabrielle' then 'female'
     when 'gail'      then 'female' when 'gina'     then 'female' when 'gloria' then 'female'
     when 'grace'     then 'female' when 'gwendolyn' then 'female' when 'hannah' then 'female'
     when 'heather'   then 'female' when 'heidi'    then 'female' when 'helen' then 'female'
     when 'holly'     then 'female' when 'irene'    then 'female' when 'isabella' then 'female'
     when 'isabelle'  then 'female' when 'jackie'   then 'female' when 'jacqueline' then 'female'
     when 'jamie'     then null   -- ambiguous
     when 'jane'      then 'female' when 'janet'    then 'female' when 'janice' then 'female'
     when 'jasmine'   then 'female' when 'jean'     then null   -- ambiguous (English F, French M)
     when 'jeanette'  then 'female' when 'jenna'    then 'female' when 'jennifer' then 'female'
     when 'jenny'     then 'female' when 'jessica'  then 'female' when 'jill'  then 'female'
     when 'joan'      then 'female' when 'joanna'   then 'female' when 'joanne' then 'female'
     when 'jocelyn'   then 'female' when 'jodi'     then 'female' when 'jody'  then 'female'
     when 'joy'       then 'female' when 'joyce'    then 'female' when 'judith' then 'female'
     when 'judy'      then 'female' when 'julia'    then 'female' when 'julie' then 'female'
     when 'june'      then 'female' when 'karen'    then 'female' when 'katherine' then 'female'
     when 'kathleen'  then 'female' when 'kathryn'  then 'female' when 'kathy' then 'female'
     when 'katie'     then 'female' when 'kayla'    then 'female' when 'kelly' then null
     when 'kelsey'    then 'female' when 'kendra'   then 'female' when 'kim'   then 'female'
     when 'kimberly'  then 'female' when 'krista'   then 'female' when 'kristen' then 'female'
     when 'kristin'   then 'female' when 'kristina' then 'female' when 'kristy' then 'female'
     when 'laura'     then 'female' when 'lauren'   then 'female' when 'laurie' then 'female'
     when 'leah'      then 'female' when 'leslie'   then null
     when 'lillian'   then 'female' when 'lily'     then 'female' when 'linda' then 'female'
     when 'lindsay'   then 'female' when 'lindsey'  then 'female' when 'lisa'  then 'female'
     when 'lori'      then 'female' when 'louise'   then 'female' when 'lucia' then 'female'
     when 'lucy'      then 'female' when 'lydia'    then 'female' when 'lynn'  then 'female'
     when 'mackenzie' then 'female' when 'madeline' then 'female' when 'madison' then 'female'
     when 'margaret'  then 'female' when 'maria'    then 'female' when 'marie' then 'female'
     when 'marilyn'   then 'female' when 'marissa'  then 'female' when 'marsha' then 'female'
     when 'martha'    then 'female' when 'mary'     then 'female' when 'maureen' then 'female'
     when 'maya'      then 'female' when 'meagan'   then 'female' when 'megan' then 'female'
     when 'melanie'   then 'female' when 'melissa'  then 'female' when 'meredith' then 'female'
     when 'mia'       then 'female' when 'michelle' then 'female' when 'molly' then 'female'
     when 'monica'    then 'female' when 'naomi'    then 'female' when 'natalie' then 'female'
     when 'natasha'   then 'female' when 'nicole'   then 'female' when 'nina'  then 'female'
     when 'nora'      then 'female' when 'olivia'   then 'female' when 'pam'   then 'female'
     when 'pamela'    then 'female' when 'patricia' then 'female' when 'paula' then 'female'
     when 'peggy'     then 'female' when 'penelope' then 'female' when 'phyllis' then 'female'
     when 'priscilla' then 'female' when 'rachel'   then 'female' when 'rebecca' then 'female'
     when 'regina'    then 'female' when 'renee'    then 'female' when 'rhonda' then 'female'
     when 'riley'     then null   -- ambiguous
     when 'rita'      then 'female' when 'roberta'  then 'female' when 'robin' then null  -- ambiguous
     when 'rosa'      then 'female' when 'rose'     then 'female' when 'ruby'  then 'female'
     when 'ruth'      then 'female' when 'sabrina'  then 'female' when 'sally' then 'female'
     when 'samantha'  then 'female' when 'sandra'   then 'female' when 'sara' then 'female'
     when 'sarah'     then 'female' when 'savannah' then 'female' when 'sharon' then 'female'
     when 'sheila'    then 'female' when 'sherry'   then 'female' when 'shirley' then 'female'
     when 'sofia'     then 'female' when 'sonia'    then 'female' when 'sophia' then 'female'
     when 'sophie'    then 'female' when 'stacey'   then 'female' when 'stacy' then 'female'
     when 'stephanie' then 'female' when 'sue'      then 'female' when 'susan' then 'female'
     when 'susanne'   then 'female' when 'suzanne'  then 'female' when 'sydney' then 'female'
     when 'sylvia'    then 'female' when 'tabitha'  then 'female' when 'tamara' then 'female'
     when 'tammy'     then 'female' when 'tanya'    then 'female' when 'tara' then 'female'
     when 'teresa'    then 'female' when 'tiffany'  then 'female' when 'tina' then 'female'
     when 'tracy'     then null   -- ambiguous
     when 'valerie'   then 'female' when 'vanessa'  then 'female' when 'veronica' then 'female'
     when 'vicki'     then 'female' when 'vicky'    then 'female' when 'victoria' then 'female'
     when 'violet'    then 'female' when 'virginia' then 'female' when 'wendy' then 'female'
     when 'whitney'   then 'female' when 'yvonne'   then 'female' when 'zoe'   then 'female'

     else null
   end
 where gender is null;

-- Re-run the ELO replay with the new gender data
select public.recompute_doubles_ratings();

-- ── Review: anyone still missing a gender ──────────────────
-- Players in this list will have their doubles matches labeled
-- 'unspecified' until you UPDATE them manually, e.g.:
--   update public.profiles set gender = 'female' where id = '<uuid>';
-- (then re-run `select public.recompute_doubles_ratings();`)
select id, full_name, username
  from public.profiles
 where gender is null
 order by full_name;
